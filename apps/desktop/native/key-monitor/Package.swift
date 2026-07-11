// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LegalWorkKeyMonitor",
    platforms: [.macOS("12.0")],
    targets: [
        .executableTarget(
            name: "LegalWorkKeyMonitor",
            path: "Sources/KeyMonitor"
        )
    ]
)
