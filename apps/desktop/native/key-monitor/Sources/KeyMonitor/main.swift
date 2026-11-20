import AppKit
import ApplicationServices
import CoreAudio
import CryptoKit
import Darwin
import Foundation
import IOKit.hid

// MARK: - Permission check/request modes
//
// Besides the default long-running monitor, the helper doubles as the app's
// native probe for the two TCC permissions Electron cannot reach:
//
//   --paste               Post Command+V, then observe insertion.
//   --prepare-paste       Enable AX information during recording, without waiting.
//   --check               Input Monitoring, without prompting. Emits JSON and
//                         exits 0. `tapEnabled` is the end-to-end truth: a
//                         stale grant (app updated while the pane toggle stays
//                         on) still creates taps but the OS silently refuses
//                         to enable them, so "created but not enabled" is the
//                         broken state the settings UI must explain.
//   --request             Trigger the Input Monitoring consent prompt (and
//                         register the app in the pane). Emits JSON.
//   --check-automation    Apple Events consent for System Events (the paste
//                         keystroke path), without prompting.
//   --request-automation  Trigger the Apple Events consent alert.
//
// The helper is spawned by the app, so macOS attributes every prompt and pane
// entry to LegalWork (the responsible process), same as the monitor itself.

private func emitJSON(_ pairs: [(String, String)]) {
    let body = pairs.map { "\"\($0.0)\":\($0.1)" }.joined(separator: ",")
    FileHandle.standardOutput.write(Data("{\(body)}\n".utf8))
}

/// Create a probe tap and report whether the OS actually lets it run.
/// Enabling is asynchronous server-side, so give the run loop a moment
/// before reading the enabled state back.
private func probeTapHealth() -> (created: Bool, enabled: Bool) {
    let mask = (1 << CGEventType.keyDown.rawValue)
        | (1 << CGEventType.keyUp.rawValue)
        | (1 << CGEventType.flagsChanged.rawValue)
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: CGEventMask(mask),
        callback: { _, _, event, _ in Unmanaged.passUnretained(event) },
        userInfo: nil
    ) else {
        return (false, false)
    }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    CFRunLoopRunInMode(.defaultMode, 0.25, false)
    let enabled = CGEvent.tapIsEnabled(tap: tap)
    CGEvent.tapEnable(tap: tap, enable: false)
    CFMachPortInvalidate(tap)
    return (true, enabled)
}

private func runInputMonitoringCheck() -> Never {
    let access = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)
    let state: String
    switch access {
    case kIOHIDAccessTypeGranted: state = "granted"
    case kIOHIDAccessTypeDenied: state = "denied"
    default: state = "not-determined"
    }
    var created = false
    var enabled = false
    if access == kIOHIDAccessTypeGranted {
        (created, enabled) = probeTapHealth()
    }
    emitJSON([
        ("state", "\"\(state)\""),
        ("tapCreated", created ? "true" : "false"),
        ("tapEnabled", enabled ? "true" : "false"),
    ])
    exit(0)
}

private func runInputMonitoringRequest() -> Never {
    // Shows the consent prompt when undetermined and registers the app in
    // the Input Monitoring pane either way. Returns the resulting grant.
    let granted = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    emitJSON([("granted", granted ? "true" : "false")])
    exit(0)
}

private let systemEventsBundleID = "com.apple.systemevents"

private func automationPermissionStatus(askUser: Bool) -> String {
    var address = AEAddressDesc()
    let creation = systemEventsBundleID.utf8CString.withUnsafeBufferPointer { buffer in
        AECreateDesc(
            typeApplicationBundleID,
            buffer.baseAddress,
            buffer.count - 1,
            &address
        )
    }
    guard creation == noErr else { return "unavailable" }
    defer { AEDisposeDesc(&address) }

    var status = AEDeterminePermissionToAutomateTarget(
        &address, typeWildCard, typeWildCard, askUser
    )
    if status == procNotFound {
        // System Events is not running; consent cannot be determined against
        // a dead target. Launch it (it is a faceless background app) and ask
        // again once.
        if let url = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: systemEventsBundleID
        ) {
            let semaphore = DispatchSemaphore(value: 0)
            NSWorkspace.shared.openApplication(
                at: url,
                configuration: NSWorkspace.OpenConfiguration()
            ) { _, _ in semaphore.signal() }
            _ = semaphore.wait(timeout: .now() + 3)
            status = AEDeterminePermissionToAutomateTarget(
                &address, typeWildCard, typeWildCard, askUser
            )
        }
    }
    switch status {
    case noErr: return "granted"
    case OSStatus(errAEEventNotPermitted): return "denied"
    case OSStatus(errAEEventWouldRequireUserConsent): return "not-determined"
    default: return "unavailable"
    }
}

private func runAutomationMode(askUser: Bool) -> Never {
    emitJSON([("state", "\"\(automationPermissionStatus(askUser: askUser))\"")])
    exit(0)
}

// Query device metadata without opening an audio stream or changing routing.
// Keeping dictation off a Bluetooth microphone preserves its playback mode.
private func audioUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value
}

private struct DictationNativeInput: Encodable {
    let name: String
    let bluetooth: Bool
    let builtIn: Bool
}

private struct DictationInputInfo: Encodable {
    var inputs: [DictationNativeInput] = []
    var defaultInputName: String?
    var lidClosed = false
}

private func dictationInputInfo() -> DictationInputInfo {
    var result = DictationInputInfo()
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    if service != 0 {
        if let property = IORegistryEntryCreateCFProperty(service, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0) {
            result.lidClosed = property.takeRetainedValue() as? Bool ?? false
        }
        IOObjectRelease(service)
    }
    let defaultInput = audioUInt32(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return result }
    var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    let status = devices.withUnsafeMutableBytes { bytes in
        guard let pointer = bytes.baseAddress else { return OSStatus(kAudioHardwareUnspecifiedError) }
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, pointer)
    }
    guard status == noErr else { return result }
    for device in devices {
        var streamsAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var streamsSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &streamsAddress, 0, nil, &streamsSize) == noErr, streamsSize > 0 else { continue }
        var nameAddress = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var name: Unmanaged<CFString>?
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        if AudioObjectGetPropertyData(device, &nameAddress, 0, nil, &nameSize, &name) == noErr, let name {
            let label = name.takeRetainedValue() as String
            let transport = audioUInt32(device, kAudioDevicePropertyTransportType)
            result.inputs.append(DictationNativeInput(
                name: label,
                bluetooth: transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE,
                builtIn: transport == kAudioDeviceTransportTypeBuiltIn
            ))
            if device == defaultInput { result.defaultInputName = label }
        }
    }
    return result
}

private func runDictationInputMode() -> Never {
    let result = dictationInputInfo()
    if let data = try? JSONEncoder().encode(result) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
    exit(0)
}

private struct MeetingDocument: Encodable {
    let title: String
    let url: String
}

private struct MeetingProcess: Encodable {
    let bundleId: String
    let inputActive: Bool
    let documents: [MeetingDocument]
}

private func audioString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value?.takeRetainedValue() as String?
}

private func axString(_ element: AXUIElement, _ attribute: String) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return "" }
    if let url = value as? URL { return url.absoluteString }
    return value as? String ?? ""
}

private func meetingApplication(_ object: AudioObjectID, _ bundleId: String, _ apps: [NSRunningApplication]) -> NSRunningApplication? {
    // Audio helpers can have a different bundle ID from their call app.
    // Resolve the real owning app through its process ancestry first.
    var pid = pid_t(audioUInt32(object, kAudioProcessPropertyPID) ?? 0)
    for _ in 0..<8 {
        if let app = apps.first(where: { $0.processIdentifier == pid && $0.activationPolicy == .regular }) { return app }
        guard pid > 1 else { break }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { break }
        let parent = pid_t(info.pbi_ppid)
        guard parent != pid else { break }
        pid = parent
    }
    return apps.first { app in
        guard let id = app.bundleIdentifier else { return false }
        return app.activationPolicy == .regular && (bundleId == id || bundleId.hasPrefix(id + "."))
    }
}

// Read window metadata and the top-level document URL only. Stop at web areas
// instead of traversing page contents or collecting conversation text.
private func meetingDocuments(_ app: NSRunningApplication) -> [MeetingDocument] {
    // Window titles remain useful when Accessibility is unavailable. Reading
    // them uses the existing Screen Recording permission, never a new prompt.
    let windowInfo = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let titles = windowInfo.compactMap { info -> MeetingDocument? in
        guard let pid = info[kCGWindowOwnerPID as String] as? Int32, pid == app.processIdentifier,
              let title = info[kCGWindowName as String] as? String, !title.isEmpty else { return nil }
        return MeetingDocument(title: title, url: "")
    }
    guard AXIsProcessTrusted() else { return titles }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 0.1)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement] else { return titles }
    let deadline = Date().addingTimeInterval(0.8)
    return titles + windows.prefix(8).map { window in
        if Date() >= deadline { return MeetingDocument(title: "", url: "") }
        let title = axString(window, kAXTitleAttribute)
        var url = axString(window, kAXDocumentAttribute)
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var visited = 0
        while url.isEmpty, !queue.isEmpty, visited < 80, Date() < deadline {
            let (node, depth) = queue.removeFirst()
            visited += 1
            url = axString(node, kAXURLAttribute)
            if !url.isEmpty { break }
            if depth >= 5 || axString(node, kAXRoleAttribute) == "AXWebArea" { continue }
            var childrenValue: CFTypeRef?
            if AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &childrenValue) == .success,
               let children = childrenValue as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(20).map { ($0, depth + 1) })
            }
        }
        return MeetingDocument(title: title, url: url)
    }
}

private func runMeetingActivityMode() -> Never {
    struct Result: Encodable { let supported: Bool; let processes: [MeetingProcess] }
    var processes: [MeetingProcess] = []
    let supported: Bool
    if #available(macOS 14.2, *) {
        supported = true
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        if AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr {
            var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
            let status = objects.withUnsafeMutableBytes { bytes in
                guard let pointer = bytes.baseAddress else { return OSStatus(kAudioHardwareUnspecifiedError) }
                return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, pointer)
            }
            if status == noErr {
                let apps = NSWorkspace.shared.runningApplications
                let nativeIds = ["us.zoom.xos", "com.microsoft.teams2", "com.microsoft.teams", "com.tinyspeck.slackmacgap", "com.cisco.webexmeetingsapp", "com.cisco.webex"]
                let browserIds = ["com.google.Chrome", "com.microsoft.edgemac", "company.thebrowser.Browser", "company.thebrowser.dia", "com.apple.Safari", "org.mozilla.firefox", "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "org.chromium.Chromium"]
                var seen = Set<String>()
                for object in objects where audioUInt32(object, kAudioProcessPropertyIsRunningInput) == 1 {
                    guard let bundleId = audioString(object, kAudioProcessPropertyBundleID), !bundleId.isEmpty else { continue }
                    // Browser audio runs in helper processes; read the parent
                    // application's windows, not the helper's empty AX tree.
                    guard let app = meetingApplication(object, bundleId, apps), let id = app.bundleIdentifier, !seen.contains(id) else { continue }
                    guard nativeIds.contains(id) || browserIds.contains(id) else { continue }
                    seen.insert(id)
                    processes.append(MeetingProcess(bundleId: id, inputActive: true, documents: browserIds.contains(id) ? meetingDocuments(app) : []))
                }
                // Joining with the microphone muted must not make the browser
                // invisible to detection. Inspect metadata even without input.
                for app in apps {
                    guard let id = app.bundleIdentifier, browserIds.contains(id), !seen.contains(id) else { continue }
                    seen.insert(id)
                    processes.append(MeetingProcess(bundleId: id, inputActive: false, documents: meetingDocuments(app)))
                }
            }
        }
    } else { supported = false }
    if let data = try? JSONEncoder().encode(Result(supported: supported, processes: processes)) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
    exit(0)
}

// NSScreen.main follows keyboard focus across apps, without an Accessibility
// query or an additional permission. Keep a run loop for AppKit screen updates.
private func runFocusedDisplayMode() -> Never {
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    let parent = getppid()
    var previous = Int.min
    let emit = {
        if getppid() != parent { exit(0) }
        let id = (NSScreen.main?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? -1
        if id != previous {
            previous = id
            emitJSON([("displayId", id == -1 ? "null" : String(id))])
        }
    }
    emit()
    let timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in emit() }
    RunLoop.main.add(timer, forMode: .common)
    RunLoop.main.run()
    exit(0)
}

// MARK: - Launcher origin modes
//
// The quick panel records the app the user was working in before it takes
// focus, reads that app's selection on request, and returns focus to it before
// inserting a result. Only identifiers and the selected text leave this
// helper; no window contents are watched continuously.
//
//   --frontmost            JSON: the frontmost application and its focused
//                          window title (Accessibility, no prompt).
//   --selected-text <pid>  JSON: the focused element's selected text in that
//                          process, or a reason it is unavailable.
//   --activate <pid>       Bring that process to the front; exit 0 on success.

private func jsonString(_ value: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[\"\"]".utf8)
    let text = String(decoding: data, as: UTF8.self)
    return String(text.dropFirst().dropLast())
}

private func focusedWindowTitle(_ pid: pid_t) -> String? {
    let element = AXUIElementCreateApplication(pid)
    var window: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &window) == .success, let windowElement = window else { return nil }
    var title: AnyObject?
    guard AXUIElementCopyAttributeValue(windowElement as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success else { return nil }
    return title as? String
}

private func runFrontmostMode() -> Never {
    guard let app = NSWorkspace.shared.frontmostApplication else {
        emitJSON([("ok", "false"), ("reason", jsonString("none"))])
        exit(0)
    }
    let trusted = AXIsProcessTrusted()
    let title = trusted ? focusedWindowTitle(app.processIdentifier) : nil
    emitJSON([
        ("ok", "true"), ("pid", String(app.processIdentifier)),
        ("app", jsonString(app.localizedName ?? "")), ("bundleId", jsonString(app.bundleIdentifier ?? "")),
        ("window", title.map(jsonString) ?? "null"), ("accessibility", trusted ? "true" : "false"),
    ])
    exit(0)
}

private let wordSelectionGet = AEEventID(kAEGetData)
private let wordSelectionSuite = AEEventClass(kAECoreSuite)

private func wordCode(_ value: String) -> OSType {
    value.utf8.reduce(0) { ($0 << 8) | OSType($1) }
}

// Word.sdef's read-only property chain. No script evaluation, launch, editing,
// Copy command, or general pasteboard access is involved.
private func readWordSelection(pid: pid_t, captions: Set<String>, allowPrompt: Bool, isSameDocument: () -> Bool) -> (text: String?, reason: String) {
    guard isSameDocument() else { return (nil, "changed") }
    let target = NSAppleEventDescriptor(processIdentifier: pid)
    let preflight = AEDeterminePermissionToAutomateTarget(target.aeDesc, wordSelectionSuite, wordSelectionGet, false)
    let permission: OSStatus
    if preflight == OSStatus(errAEEventWouldRequireUserConsent), allowPrompt, isSameDocument() {
        permission = AEDeterminePermissionToAutomateTarget(target.aeDesc, wordSelectionSuite, wordSelectionGet, true)
    } else {
        permission = preflight
    }
    guard permission == noErr else { return (nil, "word-automation") }
    guard isSameDocument() else { return (nil, "changed") }

    func property(_ name: String, of container: NSAppleEventDescriptor) -> NSAppleEventDescriptor? {
        let specifier = NSAppleEventDescriptor.record()
        specifier.setDescriptor(NSAppleEventDescriptor(typeCode: typeProperty), forKeyword: AEKeyword(keyAEDesiredClass))
        specifier.setDescriptor(NSAppleEventDescriptor(enumCode: OSType(formPropertyID)), forKeyword: AEKeyword(keyAEKeyForm))
        specifier.setDescriptor(NSAppleEventDescriptor(typeCode: wordCode(name)), forKeyword: AEKeyword(keyAEKeyData))
        specifier.setDescriptor(container, forKeyword: AEKeyword(keyAEContainer))
        return specifier.coerce(toDescriptorType: typeObjectSpecifier)
    }

    func read(_ specifier: NSAppleEventDescriptor) throws -> String? {
        let event = NSAppleEventDescriptor(eventClass: wordSelectionSuite, eventID: wordSelectionGet, targetDescriptor: target, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        event.setParam(specifier, forKeyword: keyDirectObject)
        let reply = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: 1)
        guard reply.paramDescriptor(forKeyword: keyErrorNumber)?.int32Value ?? 0 == 0 else { return nil }
        return reply.paramDescriptor(forKeyword: keyDirectObject)?.stringValue
    }

    guard let window = property("1004", of: NSAppleEventDescriptor.null()),
          let caption = property("1065", of: window),
          let selection = property("sele", of: window),
          let content = property("1650", of: selection)
    else { return (nil, "unsupported") }
    do {
        guard let name = try read(caption), captions.contains(name), isSameDocument() else { return (nil, "changed") }
        let text = try read(content)
        guard try read(caption) == name, isSameDocument() else { return (nil, "changed") }
        if let text { return (text.isEmpty ? nil : text, "empty") }
        return (nil, "unsupported")
    } catch { return (nil, "unsupported") }
}

private func runSelectedTextMode(_ pidText: String?, expectedWindow: String?, allowWordPrompt: Bool) -> Never {
    guard let pidText, let pid = Int32(pidText) else { emitJSON([("ok", "false"), ("reason", jsonString("no-origin"))]); exit(0) }
    guard AXIsProcessTrusted() else { emitJSON([("ok", "false"), ("reason", jsonString("denied"))]); exit(0) }
    // Accessibility reads a background app's focused element, so the panel may keep focus while the selection is read.
    guard let sourceApp = NSRunningApplication(processIdentifier: pid) else {
        emitJSON([("ok", "false"), ("reason", jsonString("changed"))]); exit(0)
    }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.35)

    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    func string(for range: CFTypeRef, in element: AXUIElement, attribute name: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, name as CFString, range, &value) == .success else { return nil }
        return value as? String
    }

    func readSelection(startingAt candidate: AXUIElement? = nil) -> (text: String?, supported: Bool, secure: Bool) {
        var current = candidate ?? attribute(application, kAXFocusedUIElementAttribute)
        if current == nil, let focused = attribute(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute),
           CFGetTypeID(focused) == AXUIElementGetTypeID() {
            var focusedPid: pid_t = 0
            if AXUIElementGetPid(focused as! AXUIElement, &focusedPid) == .success, focusedPid == pid { current = focused }
        }
        current = current ?? attribute(application, kAXFocusedWindowAttribute)
        var supported = false
        for _ in 0..<6 {
            guard let value = current, CFGetTypeID(value) == AXUIElementGetTypeID() else { break }
            let element = value as! AXUIElement
            if attribute(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { return (nil, false, true) }
            if let text = attribute(element, kAXSelectedTextAttribute) as? String {
                if !text.isEmpty { return (text, true, false) }
                supported = true
            }
            for (rangeName, stringName) in [
                ("AXSelectedTextRange", "AXStringForRange"),
                ("AXSelectedTextMarkerRange", "AXStringForTextMarkerRange"),
            ] {
                guard let range = attribute(element, rangeName),
                      let text = string(for: range, in: element, attribute: stringName) else { continue }
                if !text.isEmpty { return (text, true, false) }
                supported = true
            }
            if let ranges = attribute(element, "AXSelectedTextRanges") as? [CFTypeRef] {
                let parts = ranges.compactMap { string(for: $0, in: element, attribute: "AXStringForRange") }
                if parts.count == ranges.count {
                    let text = parts.filter { !$0.isEmpty }.joined(separator: "\n")
                    if !text.isEmpty { return (text, true, false) }
                    supported = true
                }
            }
            current = attribute(element, kAXParentAttribute)
        }
        return (nil, supported, false)
    }

    let isWord = sourceApp.bundleIdentifier == "com.microsoft.Word"
    func matchesRecordedWordWindow() -> Bool {
        guard isWord, let expectedWindow else { return true }
        guard let focused = attribute(application, kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(),
              let title = attribute(focused as! AXUIElement, kAXTitleAttribute) as? String
        else { return false }
        return SHA256.hash(data: Data(title.utf8)).map { String(format: "%02x", $0) }.joined() == expectedWindow
    }
    guard matchesRecordedWordWindow() else {
        emitJSON([("ok", "false"), ("reason", jsonString("changed"))])
        exit(0)
    }
    _ = attribute(application, kAXRoleAttribute)
    var selection = readSelection()
    if !selection.supported && !selection.secure {
        // Chromium turns on full accessibility after one enhanced-UI request
        // and a two-second debounce. Repeating the setter restarts its timer.
        let bundle = sourceApp.bundleIdentifier?.lowercased() ?? ""
        let chromium = ["com.google.chrome", "org.chromium.chromium", "com.microsoft.edgemac", "com.brave.browser", "company.thebrowser.browser"]
            .contains { bundle.hasPrefix($0) }
        let manual = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
        if !manual && chromium {
            _ = AXUIElementSetAttributeValue(application, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        }
        let attempts = manual ? 4 : chromium ? 10 : 0
        for _ in 0..<attempts {
            Thread.sleep(forTimeInterval: 0.24)
            selection = readSelection()
            if selection.supported || selection.secure { break }
        }
    }
    if selection.text == nil && !selection.secure,
       let window = attribute(application, kAXFocusedWindowAttribute),
       CFGetTypeID(window) == AXUIElementGetTypeID() {
        var stack = [window as! AXUIElement]
        var examined = 0
        let deadline = Date().addingTimeInterval(0.2)
        // Some apps expose focus on a descendant of their focused window.
        while let element = stack.popLast(), examined < 90, Date() < deadline {
            examined += 1
            if attribute(element, kAXFocusedAttribute) as? Bool == true {
                let result = readSelection(startingAt: element)
                if result.text != nil || result.secure { selection = result; break }
            }
            if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                stack.append(contentsOf: children.prefix(30).reversed())
            }
        }
    }
    var wordFailure: String?
    if selection.text == nil, !selection.secure, isWord, expectedWindow != nil, matchesRecordedWordWindow(),
       let value = attribute(application, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID(),
       let title = attribute(value as! AXUIElement, kAXTitleAttribute) as? String {
        let window = value as! AXUIElement
        let document = attribute(window, kAXDocumentAttribute) as? String
        func isSameDocument() -> Bool {
            guard !sourceApp.isTerminated,
                  let current = attribute(application, kAXFocusedWindowAttribute), CFEqual(current, window),
                  attribute(window, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole,
                  attribute(window, kAXTitleAttribute) as? String == title,
                  attribute(window, kAXDocumentAttribute) as? String == document,
                  attribute(window, kAXModalAttribute) as? Bool != true,
                  (attribute(window, "AXSheets") as? [AXUIElement] ?? []).isEmpty,
                  !(attribute(window, kAXChildrenAttribute) as? [AXUIElement] ?? []).contains(where: {
                      attribute($0, kAXRoleAttribute) as? String == kAXSheetRole || attribute($0, kAXModalAttribute) as? Bool == true
                  }),
                  let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement],
                  windows.filter({ attribute($0, kAXTitleAttribute) as? String == title }).count == 1,
                  let focus = attribute(application, kAXFocusedUIElementAttribute), CFGetTypeID(focus) == AXUIElementGetTypeID()
            else { return false }
            let element = focus as! AXUIElement
            guard attribute(element, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole else { return false }
            func containsEditor(_ element: AXUIElement, depth: Int) -> Bool {
                let role = attribute(element, kAXRoleAttribute) as? String
                if role == kAXLayoutAreaRole { return true }
                guard depth > 0, [kAXScrollAreaRole, kAXSplitGroupRole, kAXGroupRole].contains(role) else { return false }
                return (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(8)
                    .contains { containsEditor($0, depth: depth - 1) }
            }
            let role = attribute(element, kAXRoleAttribute) as? String
            // Word can report focus on the editor's split group. Require a
            // document URL before using that broader focus signal.
            return containsEditor(element, depth: role == kAXSplitGroupRole && document != nil ? 3 : 1)
        }
        if isSameDocument() {
            var captions: Set<String> = [title]
            if let document, let url = URL(string: document), url.isFileURL {
                captions.insert(url.lastPathComponent)
            }
            let word = readWordSelection(pid: pid, captions: captions, allowPrompt: allowWordPrompt, isSameDocument: isSameDocument)
            selection.text = word.text
            wordFailure = word.reason
        }
    }
    if !matchesRecordedWordWindow() {
        emitJSON([("ok", "false"), ("reason", jsonString("changed"))])
    } else if let text = selection.text {
        if text.utf16.count > 200_000 {
            emitJSON([("ok", "false"), ("reason", jsonString("too-large"))])
        } else {
            emitJSON([("ok", "true"), ("text", jsonString(text))])
        }
    } else {
        emitJSON([("ok", "false"), ("reason", jsonString(wordFailure ?? (selection.supported ? "empty" : "unsupported")))])
    }
    exit(0)
}

private func runActivateMode(_ pidText: String?) -> Never {
    guard let pidText, let pid = Int32(pidText), let app = NSRunningApplication(processIdentifier: pid) else {
        emitJSON([("ok", "false"), ("reason", jsonString("no-origin"))]); exit(0)
    }
    let activated = app.activate(options: [.activateIgnoringOtherApps])
    // Activation is asynchronous; confirm the frontmost app before reporting success.
    var attempts = 0
    while attempts < 20 && NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        CFRunLoopRunInMode(.defaultMode, 0.05, false)
        attempts += 1
    }
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    emitJSON([("ok", (activated && front) ? "true" : "false"), ("reason", jsonString(front ? "" : "changed"))])
    exit(0)
}

private let modeArguments = CommandLine.arguments.dropFirst()
if let mode = modeArguments.first {
    switch mode {
    case "--frontmost": runFrontmostMode()
    case "--selected-text":
        let arguments = Array(modeArguments.dropFirst())
        runSelectedTextMode(arguments.first, expectedWindow: arguments.dropFirst().first, allowWordPrompt: arguments.dropFirst(2).first == "--allow-word-automation")
    case "--activate": runActivateMode(modeArguments.dropFirst().first)
    case "--check": runInputMonitoringCheck()
    case "--request": runInputMonitoringRequest()
    case "--check-automation": runAutomationMode(askUser: false)
    case "--request-automation": runAutomationMode(askUser: true)
    case "--dictation-input": runDictationInputMode()
    case "--paste": runPasteMode()
    case "--prepare-paste": runPreparePasteMode()
    case "--meeting-activity": runMeetingActivityMode()
    case "--watch-focused-display": runFocusedDisplayMode()
    default:
        FileHandle.standardError.write(Data("Unknown mode: \(mode)\n".utf8))
        exit(64)
    }
}

private let keyNames: [CGKeyCode: String] = [
    0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X",
    8: "C", 9: "V", 11: "B", 12: "Q", 13: "W", 14: "E", 15: "R",
    16: "Y", 17: "T", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6",
    23: "5", 25: "9", 26: "7", 28: "8", 29: "0", 31: "O", 32: "U",
    34: "I", 35: "P", 37: "L", 38: "J", 40: "K", 45: "N", 46: "M",
    36: "Enter", 48: "Tab", 49: "Space", 51: "Backspace", 53: "Escape",
    54: "Command", 55: "Command", 56: "Shift", 58: "Alt", 59: "Control",
    60: "Shift", 61: "Alt", 62: "Control", 63: "Fn",
    96: "F5", 97: "F6", 98: "F7", 99: "F3", 100: "F8", 101: "F9",
    103: "F11", 105: "F13", 106: "F16", 107: "F14", 109: "F10",
    111: "F12", 113: "F15", 114: "Help", 115: "Home", 116: "PageUp",
    117: "Delete", 118: "F4", 119: "End", 120: "F2", 121: "PageDown",
    122: "F1", 123: "Left", 124: "Right", 125: "Down", 126: "Up",
]

// Punctuation depends on the active layout. In particular, the German < key
// is absent from the ANSI table above. Strip Control/Command so control
// characters do not hide its printable name, while retaining Shift/Option.
private func shortcutKeyName(_ event: CGEvent, code: CGKeyCode) -> String {
    if let name = keyNames[code] { return name }
    if (event.type == .keyDown || event.type == .keyUp),
       let nativeEvent = NSEvent(cgEvent: event),
       let characters = nativeEvent.characters(byApplyingModifiers: nativeEvent.modifierFlags.intersection([.shift, .option])),
       characters.unicodeScalars.count == 1,
       let scalar = characters.unicodeScalars.first,
       CharacterSet.punctuationCharacters.union(.symbols).contains(scalar) {
        return characters == "+" ? "Plus" : characters
    }
    return "Other\(code)"
}

// A modifier or input-source change before key-up must not leave the original
// key stuck down in the shortcut service.
private var pressedKeyNames: [CGKeyCode: String] = [:]

private let modifierFlags: [CGKeyCode: CGEventFlags] = [
    54: .maskCommand, 55: .maskCommand,
    56: .maskShift, 60: .maskShift,
    58: .maskAlternate, 61: .maskAlternate,
    59: .maskControl, 62: .maskControl,
    63: .maskSecondaryFn,
]

private var eventTap: CFMachPort?
private var runLoopSource: CFRunLoopSource?

private func emit(_ type: String, _ key: String) {
    let data = Data("\(type)\t\(key)\n".utf8)
    FileHandle.standardOutput.write(data)
}

private let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
        return Unmanaged.passUnretained(event)
    }

    let code = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
    let name = pressedKeyNames[code] ?? shortcutKeyName(event, code: code)

    switch type {
    case .keyDown:
        if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
            pressedKeyNames[code] = name
            emit("down", name)
        }
    case .keyUp:
        pressedKeyNames.removeValue(forKey: code)
        emit("up", name)
    case .flagsChanged:
        if let flag = modifierFlags[code] {
            emit(event.flags.contains(flag) ? "down" : "up", name)
        }
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

private func teardownTap() {
    pressedKeyNames.removeAll()
    if let runLoopSource {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
    }
    if let eventTap {
        CGEvent.tapEnable(tap: eventTap, enable: false)
        CFMachPortInvalidate(eventTap)
    }
    runLoopSource = nil
    eventTap = nil
}

private func createTap() -> Bool {
    let mask = (1 << CGEventType.keyDown.rawValue)
        | (1 << CGEventType.keyUp.rawValue)
        | (1 << CGEventType.flagsChanged.rawValue)

    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: CGEventMask(mask),
        callback: callback,
        userInfo: nil
    ) else {
        return false
    }

    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    eventTap = tap
    runLoopSource = source
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    return true
}

/// Sleep/wake and session switches can leave a tap that looks enabled but
/// never fires again. Rebuilding it is cheap and unambiguous; the "reset"
/// line tells the app that key-ups may have been lost so it can drop any
/// held-chord state instead of latching hold-to-talk.
private func recreateTap() {
    teardownTap()
    guard createTap() else {
        FileHandle.standardError.write(Data("Keyboard monitoring permission was revoked.\n".utf8))
        exit(2)
    }
    emit("reset", "*")
}

guard createTap() else {
    FileHandle.standardError.write(Data("Keyboard monitoring permission is required.\n".utf8))
    exit(2)
}

// Keep the listener out of App Nap: a coalesced helper services its tap
// callback late, and the OS disables taps whose callbacks run late. This
// option deliberately still allows idle system sleep.
let activity = ProcessInfo.processInfo.beginActivity(
    options: .userInitiatedAllowingIdleSystemSleep,
    reason: "Dictation hotkey listener"
)
_ = activity

let workspaceCenter = NSWorkspace.shared.notificationCenter
workspaceCenter.addObserver(
    forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
) { _ in recreateTap() }
workspaceCenter.addObserver(
    forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main
) { _ in recreateTap() }

// Watchdog for the disable path the callback cannot see: the
// tapDisabledBy* events are themselves dropped in rare cases (they are
// delivered through the same tap), so poll and re-enable.
let watchdog = CFRunLoopTimerCreateWithHandler(
    kCFAllocatorDefault,
    CFAbsoluteTimeGetCurrent() + 2.0,
    2.0,
    0,
    0
) { _ in
    if let eventTap, !CGEvent.tapIsEnabled(tap: eventTap) {
        CGEvent.tapEnable(tap: eventTap, enable: true)
        pressedKeyNames.removeAll()
        emit("reset", "*")
    }
}
CFRunLoopAddTimer(CFRunLoopGetMain(), watchdog, .commonModes)

print("ready")
fflush(stdout)
CFRunLoopRun()
