// Adapted from OpenWhispr resources/macos-fast-paste.swift.
// https://github.com/OpenWhispr/openwhispr
/*
MIT License

Copyright (c) 2024 OpenWhispr Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import AppKit
import Carbon.HIToolbox

private let commandModifierState = UInt32(cmdKey) >> 8

private func keyboardLayoutData(from inputSource: TISInputSource?) -> Data? {
    guard let inputSource = inputSource,
          let layoutDataPointer = TISGetInputSourceProperty(inputSource, kTISPropertyUnicodeKeyLayoutData) else {
        return nil
    }

    return Unmanaged<CFData>.fromOpaque(layoutDataPointer).takeUnretainedValue() as Data
}

private func lookupVirtualKey(for character: String) -> CGKeyCode? {
    // Non-ASCII layouts can define their own Command shortcuts. Use the last
    // ASCII layout only when the active input method provides no layout data.
    guard let layoutData = keyboardLayoutData(from: TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue())
        ?? keyboardLayoutData(from: TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()) else {
        return nil
    }

    return layoutData.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress else { return nil }
        let keyboardLayout = baseAddress.assumingMemoryBound(to: UCKeyboardLayout.self)
        var deadKeyState: UInt32 = 0
        var actualStringLength = 0
        var unicodeString = [UniChar](repeating: 0, count: 4)

        for keyCode in 0..<128 {
            deadKeyState = 0
            let status = UCKeyTranslate(
                keyboardLayout,
                UInt16(keyCode),
                UInt16(kUCKeyActionDisplay),
                commandModifierState,
                UInt32(LMGetKbdType()),
                OptionBits(kUCKeyTranslateNoDeadKeysBit),
                &deadKeyState,
                unicodeString.count,
                &actualStringLength,
                &unicodeString
            )
            if status == noErr,
               String(utf16CodeUnits: unicodeString, count: actualStringLength) == character {
                return CGKeyCode(keyCode)
            }
        }

        return nil
    }
}

func runPasteMode() -> Never {
    guard AXIsProcessTrusted() else { exit(2) }
    // Never substitute an ANSI key when the active Command layout is unknown.
    guard let virtualKey = lookupVirtualKey(for: "v") else { exit(3) }
    guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: false) else {
        exit(1)
    }

    let recipient = pasteRecipient()
    let expected = NSPasteboard.general.string(forType: .string) ?? ""
    keyDown.flags = .maskCommand
    keyUp.flags = .maskCommand
    keyDown.post(tap: .cgSessionEventTap)
    usleep(8000)
    keyUp.post(tap: .cgSessionEventTap)
    usleep(20000)

    // An observed insertion failure is distinct from a command error: never
    // retry a shortcut that was already delivered to the receiving app.
    exit(verifyPasteDelivery(recipient, expected: expected) == .notInserted ? 4 : 0)
}
