import XCTest

/// Shared helpers: launch arguments, waiting, and saving screenshots for the report.
class YoUITestCase: XCTestCase {
    nonisolated(unsafe) var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func launch(_ arguments: [String]) {
        app = XCUIApplication()
        app.launchArguments = ["-YoResetState"] + arguments
        app.launch()
    }

    @MainActor
    @discardableResult
    func wait(_ element: XCUIElement, _ timeout: TimeInterval = 15, file: StaticString = #filePath,
              line: UInt = #line) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Timed out waiting for \(element)", file: file,
                      line: line)
        return element
    }

    @MainActor
    func waitForLabel(_ element: XCUIElement, _ label: String, _ timeout: TimeInterval = 15,
                      file: StaticString = #filePath, line: UInt = #line) {
        let predicate = NSPredicate(format: "label == %@", label)
        let found = XCTWaiter().wait(for: [expectation(for: predicate, evaluatedWith: element)], timeout: timeout)
        XCTAssertEqual(found, .completed, "\(element) never said “\(label)”", file: file, line: line)
    }

    @MainActor
    func text(containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    @MainActor
    func send(_ message: String) {
        let composer = wait(app.textViews["composer"].exists ? app.textViews["composer"] : app.textFields["composer"])
        composer.tap()
        composer.typeText(message)
        app.buttons["send"].tap()
    }

    /// Saves a screenshot to `YO_SHOTS_DIR` (when the run sets it) and attaches it to the test result.
    @MainActor
    func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["YO_SHOTS_DIR"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }
}

/// The demo, which App Review uses: send, see Yo work, approve a card.
final class DemoUITests: YoUITestCase {
    @MainActor
    func testDemoTableBookingWithApproval() {
        launch(["-YoDemo"])
        wait(text(containing: "This is the demo"))
        send("Book a table for 4 on Friday")
        wait(app.staticTexts["working-text"])
        waitForLabel(app.staticTexts["delivery"], "Delivered")
        wait(app.buttons["approve"], 20).tap()
        waitForLabel(wait(app.staticTexts["card-outcome"]), "Approved")
        wait(text(containing: "Booked"), 20)
    }

    @MainActor
    func testWelcomeExplainsHowToGetALink() {
        launch([])
        wait(app.staticTexts["Your Yo, in your pocket"])
        app.buttons["How do I get a link?"].tap()
        wait(text(containing: "Create phone link"))
        app.buttons["Done"].tap()
        let field = wait(app.textFields["link-field"])
        field.tap()
        field.typeText("https://yo-phone.vercel.app/#k=old")
        app.buttons["connect"].tap()
        wait(app.staticTexts["pairing-error"])
    }
}

/// End to end against a local dev relay and fake core (phone/dev). Runs only when `YO_E2E_LINK` is set:
///   PORT=<port> node phone/dev/server.mjs
///   node phone/dev/fake-core.mjs --relay http://localhost:<port> --slow 6000
///   TEST_RUNNER_YO_E2E_LINK="http://localhost:<port>/#k=…" xcodebuild test … -only-testing:YoUITests/RelayE2ETests
/// `--slow 6000` keeps Yo working long enough to tap Stop; with the default 1.6 s the reply can beat the tap.
final class RelayE2ETests: YoUITestCase {
    @MainActor
    func testPairSendApproveStopRevoke() throws {
        guard let link = ProcessInfo.processInfo.environment["YO_E2E_LINK"] else {
            throw XCTSkip("Set TEST_RUNNER_YO_E2E_LINK to run the end-to-end test")
        }
        launch(["-YoPairLink", link])

        // The one-time notice about where messages go comes before the first pairing.
        wait(app.staticTexts["Where your messages go"])
        shot("e2e-0-notice")
        app.buttons["notice-ok"].tap()

        // Paired: the fake core polls, so the relay reports it online.
        waitForLabel(wait(app.staticTexts["presence"], 20), "Online", 30)
        shot("e2e-1-paired")

        // Send → Sent → Delivered (ack) → working → reply.
        send("hello from the iPhone app")
        wait(app.staticTexts["working-text"], 20)
        shot("e2e-2-working")
        waitForLabel(app.staticTexts["delivery"], "Delivered", 20)
        wait(text(containing: "Got it — hello from the iPhone app"), 30)
        shot("e2e-3-reply-delivered")

        // Approval card → Approve → resolved + follow-up reply.
        send("approval please")
        wait(app.buttons["approve"], 30)
        shot("e2e-4-approval")
        app.buttons["approve"].tap()
        waitForLabel(wait(app.staticTexts["card-outcome"], 20), "Approved", 20)
        wait(text(containing: "All set"), 30)
        shot("e2e-5-approved")

        // Stop while Yo is working.
        send("dinner ideas")
        wait(app.buttons["stop"], 20).tap()
        waitForLabel(app.staticTexts["working-text"], "Stopping…", 10)
        shot("e2e-6-stopping")
        wait(text(containing: "Via Carota"), 30)

        // The core turns the link off → back to pairing with the revoked notice.
        send("revoke this link")
        wait(app.staticTexts["This link was turned off. Ask for a new one."], 40)
        shot("e2e-7-revoked")
    }
}

/// Screenshots of the screens the App Store scenes don't cover. Runs only when `YO_SHOTS_DIR` is set; names end in
/// `YO_SHOTS_SUFFIX` (e.g. `-dark`). It never accepts the notice, so nothing is sent anywhere.
final class ScreenTourUITests: YoUITestCase {
    @MainActor
    func testTour() throws {
        guard ProcessInfo.processInfo.environment["YO_SHOTS_DIR"] != nil else {
            throw XCTSkip("Set TEST_RUNNER_YO_SHOTS_DIR to capture the screen tour")
        }
        let suffix = ProcessInfo.processInfo.environment["YO_SHOTS_SUFFIX"] ?? ""

        // The canonical test vector's link: a fixed, public test key.
        launch(["-YoPairLink", "https://yo-phone.vercel.app/#k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&a=jY3o3uB5gcBP6Sd7hq000fnWtIMv7910wsgDIxFjC2s&p=JUO5L_EJVRFHatyDadtt3JM2ZaEZeN2hQE7hBmypVZ0"])
        wait(app.staticTexts["Where your messages go"])
        shot("notice\(suffix)")
        app.buttons["Not now"].tap()

        wait(app.buttons["How do I get a link?"]).tap()
        wait(text(containing: "Create phone link"))
        shot("link-help\(suffix)")
        app.buttons["Done"].tap()

        wait(app.buttons["scan"]).tap()
        wait(app.navigationBars["Scan your phone link"])
        shot("qr-scanner\(suffix)")
        app.buttons["Cancel"].tap()

        launch(["-YoDemo"])
        send("Summarize my inbox")
        wait(text(containing: "3 things need you today"), 20)
        shot("demo-chat\(suffix)")
        app.buttons["settings-button"].tap()
        wait(app.buttons["Leave the demo"])
        shot("demo-settings\(suffix)")
    }
}
