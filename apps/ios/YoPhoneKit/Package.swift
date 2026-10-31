// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "YoPhoneKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "YoPhoneKit", targets: ["YoPhoneKit"]),
    ],
    targets: [
        .target(name: "YoPhoneKit"),
        .testTarget(
            name: "YoPhoneKitTests",
            dependencies: ["YoPhoneKit"],
            resources: [.copy("Resources/vector.json")]
        ),
    ]
)
