// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LegalWorkAudioTap",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "LegalWorkAudioTap",
            path: "Sources/AudioTap"
        )
    ]
)
