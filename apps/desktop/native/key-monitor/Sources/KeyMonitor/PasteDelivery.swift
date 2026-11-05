import AppKit
import ApplicationServices

enum PasteDelivery: Equatable {
    case inserted, notInserted, awaitingText, unknown
}

// Unknown editors retain the normal paste path; they must not become failures.
func classifyPasteDelivery(role: String?, value: String?, expected: String, noFocusedElement: Bool = false) -> PasteDelivery {
    let normalized = expected.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    guard !normalized.isEmpty else { return .unknown }
    if let value,
       value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").range(of: normalized, options: .caseInsensitive) != nil {
        return .inserted
    }
    if noFocusedElement { return .notInserted }
    if let role, [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role), value != nil { return .awaitingText }
    if let role, [kAXButtonRole, kAXCheckBoxRole, kAXRadioButtonRole, kAXSliderRole, kAXMenuItemRole, kAXStaticTextRole, kAXImageRole, "AXWebArea"].contains(role) { return .notInserted }
    return .unknown
}

private func deliveryAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}

private func deliveryElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

// This identifies the keyboard recipient, without querying field eligibility.
// NSWorkspace's cached frontmost app can lag behind keyboard focus changes.
func pasteRecipient() -> AXUIElement? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.1)
    return deliveryElement(deliveryAttribute(system, kAXFocusedApplicationAttribute))
}

func runPreparePasteMode() -> Never {
    if AXIsProcessTrusted(), let application = pasteRecipient() {
        AXUIElementSetMessagingTimeout(application, 0.1)
        // Request accessibility while recording. Electron debounces this for
        // two seconds; neither recording nor the eventual paste waits for it.
        _ = deliveryAttribute(application, kAXRoleAttribute)
        if (deliveryAttribute(application, "AXManualAccessibility") as? Bool) == false {
            AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
    }
    exit(0)
}

private func observePasteDelivery(_ application: AXUIElement, expected: String) -> PasteDelivery {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &value)
    if status == .noValue {
        // A cold Chromium tree also reports no value. Only a ready tree with
        // a readable focused window can establish that no field has focus.
        guard (deliveryAttribute(application, "AXManualAccessibility") as? Bool) == true,
              deliveryElement(deliveryAttribute(application, kAXFocusedWindowAttribute)) != nil else { return .unknown }
        return classifyPasteDelivery(role: nil, value: nil, expected: expected, noFocusedElement: true)
    }
    guard status == .success, let element = deliveryElement(value) else { return .unknown }
    if (deliveryAttribute(element, kAXSubroleAttribute) as? String) == kAXSecureTextFieldSubrole { return .unknown }
    let role = deliveryAttribute(element, kAXRoleAttribute) as? String
    // A disabled Chromium tree may expose only the page even when its editor
    // accepted text. Do not classify that incomplete view as a missing field.
    if role == "AXWebArea", (deliveryAttribute(application, "AXManualAccessibility") as? Bool) == false { return .unknown }
    return classifyPasteDelivery(
        role: role,
        value: deliveryAttribute(element, kAXValueAttribute) as? String,
        expected: expected
    )
}

// Called after BOTH key events. Failure needs affirmative evidence; missing
// accessibility information never prevents paste or forces clipboard fallback.
func verifyPasteDelivery(_ application: AXUIElement?, expected: String) -> PasteDelivery {
    guard let application else { return .unknown }
    AXUIElementSetMessagingTimeout(application, 0.1)
    var result = PasteDelivery.unknown
    for _ in 0..<5 {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        guard let current = pasteRecipient(), CFEqual(current, application) else { return .unknown }
        result = observePasteDelivery(application, expected: expected)
        if result == .inserted || result == .notInserted { return result }
    }
    return result == .awaitingText ? .notInserted : result
}
