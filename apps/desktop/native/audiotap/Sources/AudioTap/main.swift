// LegalWork audio tap helper — per-app / system audio capture on macOS 14.4+
// using Core Audio process taps (the same OS facility MacWhisper-class apps
// use for "App Audio"). Spawned by the Electron main process.
//
// Commands:
//   LegalWorkAudioTap list
//       → prints a JSON array of running GUI apps: [{pid,name,bundleId,path}]
//   LegalWorkAudioTap tap [--pids 123,456]
//       → captures audio of the given processes (or ALL system audio when no
//         pids are given), prints one JSON header line
//         {"sampleRate":N,"channels":1} to stdout, then streams raw mono
//         Float32 little-endian PCM until stdin closes or SIGTERM.
//
// Capture requires the Audio Recording TCC permission, attributed to the
// parent (LegalWork), whose Info.plist carries NSAudioCaptureUsageDescription.

import AppKit
import AudioToolbox
import CoreAudio
import Foundation

// MARK: - list

/// 32 px PNG data-URL for an app bundle's icon. Rendered here (not via
/// Electron's app.getFileIcon, which SIGTRAPs the whole app on
/// macOS 15.6 / Electron 35 — three identical crash reports, 2026-07-08).
func iconDataURL(forPath path: String) -> String {
    guard !path.isEmpty else { return "" }
    let icon = NSWorkspace.shared.icon(forFile: path)
    guard
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 32, pixelsHigh: 32,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ),
        let context = NSGraphicsContext(bitmapImageRep: rep)
    else { return "" }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    icon.draw(in: NSRect(x: 0, y: 0, width: 32, height: 32), from: .zero, operation: .copy, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { return "" }
    return "data:image/png;base64," + png.base64EncodedString()
}

func listRunningApps() {
    struct AppInfo: Codable {
        let pid: Int32
        let name: String
        let bundleId: String
        let path: String
        let icon: String
    }
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        .map {
            AppInfo(
                pid: $0.processIdentifier,
                name: $0.localizedName ?? $0.bundleIdentifier ?? "App \($0.processIdentifier)",
                bundleId: $0.bundleIdentifier ?? "",
                path: $0.bundleURL?.path ?? "",
                icon: iconDataURL(forPath: $0.bundleURL?.path ?? "")
            )
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    let data = (try? JSONEncoder().encode(apps)) ?? Data("[]".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

// MARK: - Core Audio helpers

func translatePid(_ pid: pid_t) -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var processObject = AudioObjectID(kAudioObjectUnknown)
    var pidValue = pid
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = withUnsafeMutablePointer(to: &pidValue) { pidPointer in
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            UInt32(MemoryLayout<pid_t>.size),
            pidPointer,
            &size,
            &processObject
        )
    }
    guard status == noErr, processObject != AudioObjectID(kAudioObjectUnknown) else { return nil }
    return processObject
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("legalwork-audiotap: \(message)\n".utf8))
    exit(1)
}

// MARK: - tap

final class TapCapture {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private let output = FileHandle.standardOutput

    func start(pids: [pid_t]) {
        let description: CATapDescription
        if pids.isEmpty {
            // Whole-system mixdown (mono keeps the stream small; speech only).
            description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        } else {
            let objects = pids.compactMap { translatePid($0) }
            guard !objects.isEmpty else {
                fail("none of the requested processes could be resolved for audio capture")
            }
            description = CATapDescription(monoMixdownOfProcesses: objects)
        }
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr, tapID != AudioObjectID(kAudioObjectUnknown) else {
            fail("AudioHardwareCreateProcessTap failed (\(status)) — is Audio Recording permission granted?")
        }

        // Read the tap's stream format so we know the sample rate.
        var format = AudioStreamBasicDescription()
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var formatAddress = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        status = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &formatSize, &format)
        guard status == noErr, format.mSampleRate > 0 else {
            fail("could not read tap format (\(status))")
        }
        let sampleRate = format.mSampleRate
        let channels = max(1, Int(format.mChannelsPerFrame))

        // Aggregate device wrapping the tap; auto-starts the tap stream.
        let aggregateUID = UUID().uuidString
        let composition: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "LegalWork Tap",
            kAudioAggregateDeviceUIDKey as String: aggregateUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceSubDeviceListKey as String: [] as [[String: Any]],
            kAudioAggregateDeviceTapListKey as String: [
                [
                    kAudioSubTapDriftCompensationKey as String: true,
                    kAudioSubTapUIDKey as String: description.uuid.uuidString,
                ]
            ],
        ]
        status = AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggregateID)
        guard status == noErr, aggregateID != AudioObjectID(kAudioObjectUnknown) else {
            fail("AudioHardwareCreateAggregateDevice failed (\(status))")
        }

        // Announce the stream format to the parent, then stream PCM.
        let header = "{\"sampleRate\":\(Int(sampleRate)),\"channels\":1}\n"
        output.write(Data(header.utf8))

        let writeHandle = output
        status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) {
            _, inputData, _, _, _ in
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
            guard let buffer = buffers.first, let data = buffer.mData else { return }
            let frameCount = Int(buffer.mDataByteSize) / MemoryLayout<Float32>.size
            guard frameCount > 0 else { return }
            let samples = data.bindMemory(to: Float32.self, capacity: frameCount)
            let bufferChannels = max(1, Int(buffer.mNumberChannels))
            if bufferChannels == 1 {
                writeHandle.write(Data(bytes: samples, count: frameCount * MemoryLayout<Float32>.size))
            } else {
                // Downmix interleaved channels to mono.
                let frames = frameCount / bufferChannels
                var mono = [Float32](repeating: 0, count: frames)
                for frame in 0..<frames {
                    var sum: Float32 = 0
                    for channel in 0..<bufferChannels {
                        sum += samples[frame * bufferChannels + channel]
                    }
                    mono[frame] = sum / Float32(bufferChannels)
                }
                mono.withUnsafeBufferPointer { pointer in
                    writeHandle.write(Data(buffer: pointer))
                }
            }
        }
        guard status == noErr, let procID = ioProcID else {
            fail("AudioDeviceCreateIOProcIDWithBlock failed (\(status))")
        }
        status = AudioDeviceStart(aggregateID, procID)
        guard status == noErr else {
            fail("AudioDeviceStart failed (\(status))")
        }
        _ = channels // mono downmix handled in the IO block
    }

    func stop() {
        if let procID = ioProcID, aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tapID)
        }
    }
}

// MARK: - entry point

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: LegalWorkAudioTap <list|tap> [--pids 1,2,3]")
}

switch arguments[1] {
case "list":
    listRunningApps()
case "tap":
    var pids: [pid_t] = []
    if let index = arguments.firstIndex(of: "--pids"), index + 1 < arguments.count {
        pids = arguments[index + 1]
            .split(separator: ",")
            .compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }
    }
    let capture = TapCapture()
    capture.start(pids: pids)

    let stop = {
        capture.stop()
        exit(0)
    }
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    termSource.setEventHandler(handler: stop)
    termSource.resume()
    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    intSource.setEventHandler(handler: stop)
    intSource.resume()
    // Exit when the parent closes stdin (Electron process gone).
    FileHandle.standardInput.readabilityHandler = { handle in
        if handle.availableData.isEmpty {
            DispatchQueue.main.async(execute: stop)
        }
    }
    RunLoop.main.run()
default:
    fail("unknown command: \(arguments[1])")
}
