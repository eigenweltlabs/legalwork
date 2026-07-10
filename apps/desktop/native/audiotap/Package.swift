// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LegalWorkAudioTap",
    platforms: [
        // Core Audio process taps (CATapDescription / AudioHardwareCreateProcessTap)
        // require macOS 14.4 — matches AppAudioTap.isAvailable()'s runtime gate.
        .macOS("14.4")
    ],
    targets: [
        .executableTarget(
            name: "LegalWorkAudioTap",
            path: "Sources/AudioTap"
        )
    ]
)
