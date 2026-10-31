import Foundation
import YoPhoneKit

/// Launch arguments.
///
/// - `-YoDemo`: start in the demo.
/// - `-YoScreenshotScene welcome|chat|approval|drive|settings`: a fixed state for App Store screenshots.
/// - Debug builds only: `-YoPairLink <link>` pairs with that link (the end-to-end tests use a local relay), and
///   `-YoResetState` starts from nothing.
struct LaunchOptions: Equatable {
    var demo = false
    var scene: DemoScene?
    var pairLink: String?
    var resetState = false

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        func value(after flag: String) -> String? {
            guard let i = arguments.firstIndex(of: flag), i + 1 < arguments.count else { return nil }
            return arguments[i + 1]
        }
        demo = arguments.contains("-YoDemo")
        scene = value(after: "-YoScreenshotScene").flatMap(DemoScene.init(rawValue:))
        #if DEBUG
        pairLink = value(after: "-YoPairLink")
        resetState = arguments.contains("-YoResetState")
        #endif
    }

    /// Plain-http relays on local hosts are only for development.
    static var allowsLocalRelay: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }
}
