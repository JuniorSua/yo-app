// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "YoDeviceBridge",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "YoDeviceBridge", targets: ["YoDeviceBridge"]),
    ],
    targets: [
        .target(
            name: "BridgeCore",
            linkerSettings: [
                .linkedFramework("Contacts"),
                .linkedFramework("EventKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("ImageIO"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        ),
        .executableTarget(name: "YoDeviceBridge", dependencies: ["BridgeCore"]),
        .testTarget(name: "BridgeCoreTests", dependencies: ["BridgeCore"]),
    ]
)
