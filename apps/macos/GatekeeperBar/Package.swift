// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GatekeeperBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "GatekeeperBar",
            path: "Sources/GatekeeperBar"
        )
    ]
)
