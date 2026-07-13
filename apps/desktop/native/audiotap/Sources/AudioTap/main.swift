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
import Darwin
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

let systemObject = AudioObjectID(kAudioObjectSystemObject)

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
            systemObject,
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

/// Every HAL audio process object the system currently knows about. A
/// multiprocess app (Chrome/Electron/Safari) appears as several of these —
/// one per helper that has touched audio I/O — plus/instead of its main pid.
func processObjectList() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &dataSize) == noErr else { return [] }
    let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
    guard count > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(systemObject, &address, 0, nil, &dataSize, &ids) == noErr else { return [] }
    return ids
}

/// The OS pid backing a HAL audio process object.
func processPid(_ object: AudioObjectID) -> pid_t? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyPID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var pid: pid_t = -1
    var size = UInt32(MemoryLayout<pid_t>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &pid) == noErr else { return nil }
    return pid
}

/// The macOS "responsible pid" (what Activity Monitor / TCC use to group
/// helpers under their app). Private but stable symbol in libSystem, resolved
/// at runtime so a future removal degrades to the bundle-path fallback rather
/// than failing to launch. Reliably resolves Safari/WebKit XPC helpers.
private typealias ResponsibilityFunc = @convention(c) (pid_t) -> pid_t
private let responsibilityFn: ResponsibilityFunc? = {
    // RTLD_DEFAULT searches every loaded image.
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid")
    else { return nil }
    return unsafeBitCast(symbol, to: ResponsibilityFunc.self)
}()

func responsiblePid(_ pid: pid_t) -> pid_t? {
    guard let fn = responsibilityFn else { return nil }
    let responsible = fn(pid)
    return responsible > 0 && responsible != pid ? responsible : nil
}

/// Absolute executable path of a pid. Chrome/Electron helper executables live
/// *inside* the parent .app bundle, so a path-prefix test catches the helpers
/// the responsible-pid API leaves "self-responsible".
func executablePath(_ pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 4096) // PROC_PIDPATHINFO_MAXSIZE
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    return length > 0 ? String(cString: buffer) : nil
}

/// Nominal sample rate of the default output device — used for the stream
/// header when a tap can't be formed yet (the app isn't producing audio).
func defaultOutputSampleRate() -> Double {
    var deviceAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(systemObject, &deviceAddress, 0, nil, &size, &device) == noErr,
        device != AudioObjectID(kAudioObjectUnknown)
    else { return 48000 }
    var rateAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var rate: Float64 = 48000
    size = UInt32(MemoryLayout<Float64>.size)
    guard AudioObjectGetPropertyData(device, &rateAddress, 0, nil, &size, &rate) == noErr, rate > 0
    else { return 48000 }
    return rate
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

    /// The user-selected apps. Empty = whole-system capture.
    private var selectedPids: Set<pid_t> = []
    private var selectedBundlePaths: [String] = []
    private var wholeSystem = false

    /// The audio process objects the current tap covers, so a process-list
    /// change only rebuilds when the selected app's set actually changed.
    private var currentObjects: [AudioObjectID] = []
    private var headerEmitted = false
    private var processListListener: AudioObjectPropertyListenerBlock?

    // MARK: selection resolution

    /// Every audio process object that belongs to one of the selected apps:
    /// the main pid, plus helper/renderer/audio-service processes matched by
    /// responsible-pid (Safari) or by living inside the app's .app bundle
    /// (Chrome/Electron). This is what makes multiprocess apps actually record.
    private func resolveObjects() -> [AudioObjectID] {
        let ownPid = ProcessInfo.processInfo.processIdentifier
        var matched: [AudioObjectID] = []
        var seen = Set<AudioObjectID>()
        // Seed with each selected app's main object so a tap can always form,
        // even before the app has produced any audio.
        for pid in selectedPids {
            if let object = translatePid(pid), seen.insert(object).inserted {
                matched.append(object)
            }
        }
        for object in processObjectList() {
            guard let pid = processPid(object), pid != ownPid else { continue }
            guard matchesSelection(pid) else { continue }
            if seen.insert(object).inserted { matched.append(object) }
        }
        return matched
    }

    private func matchesSelection(_ pid: pid_t) -> Bool {
        if selectedPids.contains(pid) { return true }
        if let responsible = responsiblePid(pid), selectedPids.contains(responsible) { return true }
        if let path = executablePath(pid) {
            for base in selectedBundlePaths where !base.isEmpty {
                if path == base || path.hasPrefix(base + "/") { return true }
            }
        }
        return false
    }

    // MARK: lifecycle

    func start(pids: [pid_t]) {
        selectedPids = Set(pids)
        wholeSystem = pids.isEmpty
        selectedBundlePaths = pids.compactMap {
            NSRunningApplication(processIdentifier: $0)?.bundleURL?.path
        }

        let objects = wholeSystem ? [] : resolveObjects()
        if !buildTap(objects: objects) {
            // No audio objects yet (app not playing). Emit a header from the
            // output device rate and wait — the process-list listener will
            // build the tap when a helper starts producing audio.
            emitHeaderIfNeeded(sampleRate: defaultOutputSampleRate())
        }
        installProcessListListener()
    }

    /// (Re)create the tap+aggregate over `objects` (empty = global for
    /// whole-system capture). Returns whether a tap is now running.
    @discardableResult
    private func buildTap(objects: [AudioObjectID]) -> Bool {
        if !wholeSystem && objects.isEmpty { return false }

        let description = wholeSystem
            ? CATapDescription(monoGlobalTapButExcludeProcesses: [])
            : CATapDescription(monoMixdownOfProcesses: objects)
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var newTap = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(description, &newTap)
        guard status == noErr, newTap != AudioObjectID(kAudioObjectUnknown) else {
            if !headerEmitted {
                fail("AudioHardwareCreateProcessTap failed (\(status)) — is Audio Recording permission granted?")
            }
            return false
        }

        var format = AudioStreamBasicDescription()
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var formatAddress = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        status = AudioObjectGetPropertyData(newTap, &formatAddress, 0, nil, &formatSize, &format)
        guard status == noErr, format.mSampleRate > 0 else {
            AudioHardwareDestroyProcessTap(newTap)
            return false
        }

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
        var newAggregate = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(composition as CFDictionary, &newAggregate)
        guard status == noErr, newAggregate != AudioObjectID(kAudioObjectUnknown) else {
            AudioHardwareDestroyProcessTap(newTap)
            return false
        }

        // Tear down any previous tap only now that the replacement is ready,
        // so streaming never stops mid-recording during a rebuild.
        teardownTap()

        emitHeaderIfNeeded(sampleRate: format.mSampleRate)

        let writeHandle = output
        var newProcID: AudioDeviceIOProcID?
        status = AudioDeviceCreateIOProcIDWithBlock(&newProcID, newAggregate, nil) {
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
        guard status == noErr, let procID = newProcID else {
            AudioHardwareDestroyAggregateDevice(newAggregate)
            AudioHardwareDestroyProcessTap(newTap)
            return false
        }
        status = AudioDeviceStart(newAggregate, procID)
        guard status == noErr else {
            AudioDeviceDestroyIOProcID(newAggregate, procID)
            AudioHardwareDestroyAggregateDevice(newAggregate)
            AudioHardwareDestroyProcessTap(newTap)
            return false
        }

        tapID = newTap
        aggregateID = newAggregate
        ioProcID = procID
        currentObjects = objects
        return true
    }

    private func emitHeaderIfNeeded(sampleRate: Double) {
        guard !headerEmitted else { return }
        headerEmitted = true
        let header = "{\"sampleRate\":\(Int(sampleRate)),\"channels\":1}\n"
        output.write(Data(header.utf8))
    }

    /// Watch for helper processes appearing/disappearing (e.g. a Chrome tab
    /// starts playing after capture began) and rebuild the tap over the new
    /// object set — a CATapDescription's process list is fixed at creation.
    private func installProcessListListener() {
        guard !wholeSystem else { return }
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            DispatchQueue.main.async { self?.refresh() }
        }
        processListListener = listener
        AudioObjectAddPropertyListenerBlock(systemObject, &address, DispatchQueue.main, listener)
    }

    private func refresh() {
        let objects = resolveObjects()
        if objects.sorted() == currentObjects.sorted() { return }
        buildTap(objects: objects)
    }

    private func teardownTap() {
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
        ioProcID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }

    func stop() {
        if let listener = processListListener {
            var address = AudioObjectPropertyAddress(
                mSelector: kAudioHardwarePropertyProcessObjectList,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            AudioObjectRemovePropertyListenerBlock(systemObject, &address, DispatchQueue.main, listener)
            processListListener = nil
        }
        teardownTap()
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
