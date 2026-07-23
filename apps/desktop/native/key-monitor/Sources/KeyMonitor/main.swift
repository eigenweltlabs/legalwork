import AppKit
import ApplicationServices
import Foundation
import IOKit.hid

// MARK: - Permission check/request modes
//
// Besides the default long-running monitor, the helper doubles as the app's
// native probe for the two TCC permissions Electron cannot reach:
//
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

private let modeArguments = CommandLine.arguments.dropFirst()
if let mode = modeArguments.first {
    switch mode {
    case "--check": runInputMonitoringCheck()
    case "--request": runInputMonitoringRequest()
    case "--check-automation": runAutomationMode(askUser: false)
    case "--request-automation": runAutomationMode(askUser: true)
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
    guard let name = keyNames[code] else { return Unmanaged.passUnretained(event) }

    switch type {
    case .keyDown:
        if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 { emit("down", name) }
    case .keyUp:
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
        emit("reset", "*")
    }
}
CFRunLoopAddTimer(CFRunLoopGetMain(), watchdog, .commonModes)

print("ready")
fflush(stdout)
CFRunLoopRun()
