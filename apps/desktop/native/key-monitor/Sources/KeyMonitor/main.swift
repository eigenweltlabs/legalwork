import ApplicationServices
import Foundation

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
    FileHandle.standardError.write(Data("Keyboard monitoring permission is required.\n".utf8))
    exit(2)
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
eventTap = tap
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
print("ready")
fflush(stdout)
CFRunLoopRun()
