import AppKit
import ApplicationServices
import Foundation

// Test the process that actually reads AXDocument, without observing any app.
func runWorkdayAccessibility(requested: Bool) -> Never {
    let granted: Bool
    if requested {
        let option = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        granted = AXIsProcessTrustedWithOptions([option: true] as CFDictionary)
    } else {
        granted = AXIsProcessTrusted()
    }
    FileHandle.standardOutput.write(Data((granted ? "true" : "false").utf8))
    exit(0)
}

// AXDocument is the application's represented document URL. A window title or
// a focused text control can contain unrelated content and is never a fallback.
func workdayDocumentName(_ value: Any) -> String? {
    let url: URL?
    if let supplied = value as? URL {
        url = supplied
    } else if let supplied = value as? String {
        url = URL(string: supplied)
    } else {
        return nil
    }
    guard let url, url.isFileURL, url.path.hasPrefix("/"), !url.hasDirectoryPath,
          ["", "localhost"].contains(url.host?.lowercased() ?? ""),
          url.user == nil, url.password == nil, url.port == nil,
          url.query == nil, url.fragment == nil else { return nil }
    let name = url.lastPathComponent
    let forbidden = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\:"))
    guard !name.isEmpty, !name.hasPrefix("."), name.count <= 200,
          name.rangeOfCharacter(from: forbidden) == nil else { return nil }
    return name
}

private func focusedDocument(_ pid: pid_t) -> String? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.3)
    var rawWindow: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &rawWindow) == .success,
          let rawWindow, CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else { return nil }
    let window = rawWindow as! AXUIElement
    AXUIElementSetMessagingTimeout(window, 0.3)
    var document: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXDocumentAttribute as CFString, &document) == .success,
          let document else { return nil }
    return workdayDocumentName(document)
}

func runWorkdayForeground(documentRequested: Bool) -> Never {
    var result: [String: Any] = [:]
    if let foreground = NSWorkspace.shared.frontmostApplication, let name = foreground.localizedName {
        if ["com.apple.loginwindow", "com.apple.ScreenSaver.Engine"].contains(foreground.bundleIdentifier ?? "") {
            FileHandle.standardOutput.write(Data("{\"locked\":true}".utf8))
            exit(0)
        }
        let pid = foreground.processIdentifier
        let trusted = documentRequested && AXIsProcessTrusted()
        result = ["application": name, "pid": Int(pid), "accessibility": trusted]
        if trusted, let document = focusedDocument(pid) { result["documentName"] = document }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid { result = [:] }
    }
    if let data = try? JSONSerialization.data(withJSONObject: result) {
        FileHandle.standardOutput.write(data)
    }
    exit(0)
}
