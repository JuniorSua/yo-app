import CoreGraphics
import Foundation
import XCTest

@testable import BridgeCore

/// Window listing, capture and input driven through Session with FakeDesktop. Nothing here touches
/// the real window server, Accessibility, ScreenCaptureKit or posts an event.
final class WindowTests: XCTestCase {
    var sandbox: Sandbox!
    var desktop: FakeDesktop!
    var session: Session!
    static let yoParentPid: Int32 = 4242

    override func setUpWithError() throws {
        sandbox = try Sandbox()
        desktop = FakeDesktop()
        session = try greeted(fakeSession(config: sandbox.config, desktop: desktop, excludedPids: [Self.yoParentPid]))
    }

    // MARK: - Helpers

    private func call(_ method: String, _ params: JSONValue = [:]) throws -> JSONValue {
        let request: JSONValue = ["id": "w1", "method": .string(method), "params": params]
        guard case .reply(let data) = session.handle(frame: try request.encoded()) else {
            XCTFail("expected a reply")
            return .null
        }
        return try JSONValue.parse(data)
    }

    @discardableResult
    private func result(_ method: String, _ params: JSONValue = [:], file: StaticString = #filePath, line: UInt = #line)
        throws -> JSONValue
    {
        let response = try call(method, params)
        XCTAssertEqual(response["ok"], true, "\(response)", file: file, line: line)
        return response["result"] ?? .null
    }

    private func assertError(
        _ code: String, _ method: String, _ params: JSONValue = [:], message: String? = nil,
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        let response = try call(method, params)
        XCTAssertEqual(response["ok"], false, "\(response)", file: file, line: line)
        XCTAssertEqual(response["error"]?["code"], .string(code), "\(response)", file: file, line: line)
        if let message { XCTAssertEqual(response["error"]?["message"], .string(message), file: file, line: line) }
    }

    private func array(_ value: JSONValue?) -> [JSONValue] {
        if case .array(let items)? = value { return items }
        XCTFail("not an array: \(String(describing: value))")
        return []
    }

    private func number(_ value: JSONValue?) -> Double? {
        switch value {
        case .int(let n)?: return Double(n)
        case .double(let n)?: return n
        default: return nil
        }
    }

    /// One listed, front-most, eligible window (id 10, pid 100) plus a background window (id 20, pid 200).
    private func standardDesktop() throws {
        desktop.addWindow(10, pid: 100, bundleId: "com.apple.TextEdit", name: "TextEdit", title: "Draft")
        desktop.addWindow(20, pid: 200, bundleId: "com.apple.Safari", name: "Safari",
                          bounds: CGRect(x: 0, y: 25, width: 1400, height: 900))
        try result("windows.list")
    }

    private func click(_ id: Int64 = 10, x: JSONValue = 0.5, y: JSONValue = 0.5) -> JSONValue {
        ["windowId": .int(id), "x": x, "y": y]
    }

    // MARK: - Deny list

    func testDenyListMatching() {
        let denied = [
            "com.apple.Terminal", "com.apple.terminal", "COM.GOOGLECODE.ITERM2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty",
            "io.alacritty", "net.kovidgoyal.kitty", "com.apple.systempreferences", "com.apple.Settings",
            "com.apple.keychainaccess", "com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.ActivityMonitor",
            "com.apple.Console", "com.apple.dt.Xcode", "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92",
            "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.apple.Passwords",
            "com.apple.loginwindow", "com.apple.SecurityAgent", "dev.yo.app", "dev.yo.app.helper",
            "com.t3tools.t3code", "dev.T3.Code.nightly", "app.T3Code", "io.T3TOOLS.anything",
        ]
        for id in denied { XCTAssertTrue(AppDenyList.isDenied(bundleId: id), id) }
        XCTAssertTrue(AppDenyList.isDenied(bundleId: nil))
        XCTAssertTrue(AppDenyList.isDenied(bundleId: ""))
        let allowed = ["com.apple.Safari", "com.brave.Browser", "com.apple.TextEdit", "com.apple.finder",
                       "com.apple.Terminal.extra", "dev.yo.application", "com.microsoft.VSCodeInsiders", "com.apple.Notes"]
        for id in allowed { XCTAssertFalse(AppDenyList.isDenied(bundleId: id), id) }
    }

    // MARK: - windows.list

    func testListFiltersAndKeepsFrontToBackOrder() throws {
        desktop.addWindow(1, pid: 50, bundleId: "com.apple.dock", layer: 20, bounds: CGRect(x: 0, y: 0, width: 1470, height: 956))
        desktop.addWindow(2, pid: 60, bundleId: "com.apple.Safari", name: "Safari",
                          bounds: CGRect(x: -1920, y: -200, width: 1920, height: 1080), title: nil)
        desktop.addWindow(3, pid: 70, bundleId: "com.apple.Terminal")
        desktop.addWindow(4, pid: 71, bundleId: "com.t3tools.t3code")
        desktop.addWindow(5, pid: Self.yoParentPid, bundleId: "com.github.Electron")
        desktop.addWindow(6, pid: 72, bundleId: "com.example.menu", regular: false)
        desktop.addWindow(7, pid: 73, bounds: CGRect(x: 0, y: 0, width: 79, height: 300))
        desktop.addWindow(8, pid: 73, bounds: CGRect(x: 0, y: 0, width: 300, height: 59))
        desktop.addWindow(9, pid: 73, alpha: 0)
        desktop.addWindow(11, pid: 74, layer: 3)
        desktop.addWindow(12, pid: 75, bundleId: nil)
        desktop.apps[75] = AppInfo(bundleId: nil, name: "Unbundled", regular: true)
        desktop.addWindow(13, pid: 76)
        desktop.apps[76] = nil  // process exited
        desktop.addWindow(14, pid: 80, bundleId: "com.apple.TextEdit", name: "TextEdit",
                          bounds: CGRect(x: 10, y: 40, width: 80, height: 60), title: "Notes.txt")

        let windows = array(try result("windows.list")["windows"])
        XCTAssertEqual(windows.map { $0["windowId"] }, [2, 14])
        XCTAssertEqual(windows[0], [
            "windowId": 2, "pid": 60, "bundleId": "com.apple.Safari", "appName": "Safari", "title": "",
            "bounds": ["x": -1920, "y": -200, "width": 1920, "height": 1080], "onScreen": true,
        ])
        XCTAssertEqual(windows[1]["title"], "Notes.txt")
        XCTAssertTrue(desktop.posted.isEmpty && desktop.raised.isEmpty && desktop.captures.isEmpty)
    }

    func testListRequiresScreenRecordingAndNeverPrompts() throws {
        desktop.screenRecording = false
        try assertError("permission", "windows.list", message: "screenRecording: not-requested")
        try assertError("permission", "window.capture", ["windowId": 10], message: "screenRecording: not-requested")
        XCTAssertEqual(desktop.screenRecordingRequests, 0)
        XCTAssertEqual(desktop.trustRequests, 0)
        try assertError("invalid_params", "windows.list", ["all": true])
    }

    // MARK: - permissions.request

    func testPermissionsRequestForAccessibilityAndScreenRecording() throws {
        XCTAssertEqual(try result("permissions.request", ["kind": "accessibility"]), ["status": "granted"])
        XCTAssertEqual(try result("permissions.request", ["kind": "screenRecording"]), ["status": "granted"])
        XCTAssertEqual(desktop.trustRequests, 0)
        XCTAssertEqual(desktop.screenRecordingRequests, 0)

        desktop.trusted = false
        desktop.screenRecording = false
        XCTAssertEqual(try result("permissions.request", ["kind": "accessibility"]), ["status": "not-requested"])
        XCTAssertEqual(try result("permissions.request", ["kind": "screenRecording"]), ["status": "not-requested"])
        desktop.trustAfterRequest = true
        desktop.screenRecordingAfterRequest = true
        XCTAssertEqual(try result("permissions.request", ["kind": "accessibility"]), ["status": "granted"])
        XCTAssertEqual(try result("permissions.request", ["kind": "screenRecording"]), ["status": "granted"])
        XCTAssertEqual(desktop.trustRequests, 2)
        XCTAssertEqual(desktop.screenRecordingRequests, 2)

        try assertError("invalid_params", "permissions.request", ["kind": "automation"])
        try assertError("invalid_params", "permissions.request", ["kind": "Accessibility"])
    }

    // MARK: - window.capture

    func testCaptureRevalidatesAndReportsScale() throws {
        try standardDesktop()
        let capture = try result("window.capture", ["windowId": 10])
        XCTAssertEqual(desktop.captures.map(\.0), [10])
        XCTAssertEqual(desktop.captures.map(\.1), [1600])
        XCTAssertEqual(capture["pngBase64"], .string(Data([0x89, 0x50, 0x4E, 0x47]).base64EncodedString()))
        XCTAssertEqual(capture["width"], 1600)
        XCTAssertEqual(capture["height"], 1200)
        XCTAssertEqual(number(capture["scale"]), 2.0)
        XCTAssertEqual(capture["bounds"], ["x": 100, "y": 200, "width": 800, "height": 600])
        XCTAssertEqual(capture["title"], "Draft")

        _ = try result("window.capture", ["windowId": 20, "maxWidth": 320])
        XCTAssertEqual(desktop.captures.last?.1, 320)
        _ = try result("window.capture", ["windowId": 20, "maxWidth": 2560])

        for bad: JSONValue in [
            ["windowId": 10, "maxWidth": 319], ["windowId": 10, "maxWidth": 2561], ["windowId": 0], ["windowId": -1],
            ["windowId": .int(Int64(UInt32.max) + 1)], ["windowId": "10"], ["windowId": .double(10.5)], ["windowId": true], [:],
            ["windowId": 10, "format": "jpeg"],
        ] {
            try assertError("invalid_params", "window.capture", bad)
        }
        XCTAssertEqual(desktop.captures.count, 3)
    }

    func testCaptureRefusesGoneDeniedAndIneligibleWindows() throws {
        try standardDesktop()
        desktop.addWindow(30, pid: 300, bundleId: "com.1password.1password")
        desktop.addWindow(31, pid: 301, bundleId: "com.example.panel", layer: 3)
        desktop.addWindow(32, pid: Self.yoParentPid, bundleId: "com.github.Electron")
        try assertError("not_found", "window.capture", ["windowId": 99])
        try assertError("denied", "window.capture", ["windowId": 30], message: "app is on the deny list")
        try assertError("denied", "window.capture", ["windowId": 32])
        try assertError("not_found", "window.capture", ["windowId": 31])
        desktop.windows.removeAll { $0.windowId == 10 }
        try assertError("not_found", "window.capture", ["windowId": 10])
        XCTAssertTrue(desktop.captures.isEmpty)

        desktop.captureResult = .failure(BridgeError(.notFound, "window not found"))
        try assertError("not_found", "window.capture", ["windowId": 20])
    }

    // MARK: - Coordinates

    func testFractionsConvertToGlobalPointsOnAnyDisplay() throws {
        let main = CGRect(x: 100, y: 200, width: 800, height: 600)
        XCTAssertEqual(try WindowGeometry.point(fractionX: 0, fractionY: 0, in: main), CGPoint(x: 100, y: 200))
        XCTAssertEqual(try WindowGeometry.point(fractionX: 0.5, fractionY: 0.25, in: main), CGPoint(x: 500, y: 350))
        XCTAssertEqual(try WindowGeometry.point(fractionX: 1, fractionY: 1, in: main), CGPoint(x: 899, y: 799))
        // A display to the left of and above the main display has negative global coordinates.
        let left = CGRect(x: -1920, y: -300, width: 1000, height: 500)
        XCTAssertEqual(try WindowGeometry.point(fractionX: 0.1, fractionY: 0.5, in: left), CGPoint(x: -1820, y: -50))
        XCTAssertEqual(try WindowGeometry.point(fractionX: 1, fractionY: 0, in: left), CGPoint(x: -921, y: -300))
        // A display to the right.
        let right = CGRect(x: 1470, y: 0, width: 2560, height: 1440)
        XCTAssertEqual(try WindowGeometry.point(fractionX: 0.5, fractionY: 0.5, in: right), CGPoint(x: 2750, y: 720))
        for (x, y) in [(-0.01, 0.5), (0.5, 1.0001), (Double.nan, 0.5)] {
            XCTAssertThrowsError(try WindowGeometry.point(fractionX: x, fractionY: y, in: main))
        }
        XCTAssertEqual(WindowGeometry.center(of: left), CGPoint(x: -1420, y: -50))
        XCTAssertEqual(WindowGeometry.center(of: CGRect(x: 0, y: 0, width: 81, height: 61)), CGPoint(x: 40, y: 30))
    }

    func testClickPostsAtTheConvertedPoint() throws {
        try standardDesktop()
        let response = try result("window.click", ["windowId": 10, "x": 0.5, "y": 0.25, "button": "right", "count": 2])
        XCTAssertEqual(response, ["ok": true, "bounds": ["x": 100, "y": 200, "width": 800, "height": 600]])
        XCTAssertEqual(desktop.posted, [.click(point: CGPoint(x: 500, y: 350), button: .right, count: 2)])
        XCTAssertEqual(desktop.raised, [], "already the focused front window: nothing to raise")

        _ = try result("window.click", ["windowId": 10, "x": 0, "y": 1])
        XCTAssertEqual(desktop.posted.last, .click(point: CGPoint(x: 100, y: 799), button: .left, count: 1))
    }

    func testClickParameterValidation() throws {
        try standardDesktop()
        let bad: [JSONValue] = [
            click(x: 1.01), click(x: -0.1), click(y: 2), click(x: "0.5"), click(x: true), click(x: nil),
            ["windowId": 10, "x": 0.5], ["windowId": 10, "y": 0.5],
            ["windowId": 10, "x": 0.5, "y": 0.5, "button": "middle"], ["windowId": 10, "x": 0.5, "y": 0.5, "button": 1],
            ["windowId": 10, "x": 0.5, "y": 0.5, "button": nil], ["windowId": 10, "x": 0.5, "y": 0.5, "count": nil],
            ["windowId": 10, "x": 0.5, "y": 0.5, "count": 3], ["windowId": 10, "x": 0.5, "y": 0.5, "count": 0],
            ["windowId": 10, "x": 0.5, "y": 0.5, "count": .double(1.5)], ["windowId": 10, "x": 0.5, "y": 0.5, "screenX": 4],
            ["x": 0.5, "y": 0.5],
        ]
        for params in bad { try assertError("invalid_params", "window.click", params) }
        XCTAssertTrue(desktop.posted.isEmpty)
    }

    // MARK: - Precondition order

    func testEveryPreconditionRefusesInOrderAndNothingIsPosted() throws {
        // Everything wrong at once; each fix reveals the next check in the documented order.
        desktop.trusted = false
        desktop.locked = true
        desktop.secureInput = true
        desktop.lastHIDEvent = desktop.clock - 0.5
        desktop.addWindow(40, pid: 400, bundleId: "com.apple.Safari", bounds: CGRect(x: 0, y: 0, width: 1400, height: 900))

        try assertError("invalid_params", "window.click", click(x: 3))
        try assertError("permission", "window.click", click(), message: "accessibility: not-requested")
        desktop.trusted = true
        try assertError("not_found", "window.click", click(), message: "window not found")

        desktop.addWindow(10, pid: 100, bundleId: "com.apple.Terminal")
        try assertError("denied", "window.click", click())
        desktop.apps[100] = AppInfo(bundleId: "com.apple.TextEdit", name: "TextEdit", regular: true)
        try assertError("not_found", "window.click", click(), message: "window was not listed in this session")

        desktop.screenRecording = true
        try result("windows.list")
        try assertError("secure_input", "window.click", click(), message: "screen is locked")
        desktop.locked = false
        try assertError("secure_input", "window.click", click(), message: "secure keyboard entry is on")
        desktop.secureInput = false
        try assertError("user_active", "window.click", click())
        desktop.lastHIDEvent = desktop.clock - 1.5

        // Window 40 is in front and focused; raising window 10 fails.
        desktop.raiseSucceeds = false
        try assertError("not_frontmost", "window.click", click(), message: "window cannot be raised")
        XCTAssertEqual(desktop.raised, [10])
        // Raising "works" but the window never comes to the front: polls, then gives up.
        desktop.raiseSucceeds = true
        desktop.raiseMovesToFront = false
        try assertError("not_frontmost", "window.click", click())
        XCTAssertEqual(desktop.sleeps.filter { $0 == WindowService.Tuning.pollInterval }.count, WindowService.Tuning.activationPolls)
        XCTAssertTrue(desktop.posted.isEmpty)

        desktop.raiseMovesToFront = true
        _ = try result("window.click", click())
        XCTAssertEqual(desktop.posted.count, 1)
        XCTAssertEqual(desktop.raised, [10, 10, 10])
    }

    func testPermissionCheckedBeforeAnythingElse() throws {
        try standardDesktop()
        desktop.trusted = false
        for (method, params) in [
            ("window.click", click()), ("window.type", ["windowId": 10, "text": "hi"]),
            ("window.key", ["windowId": 10, "key": "return"]), ("window.scroll", ["windowId": 10, "dy": 100]),
        ] as [(String, JSONValue)] {
            try assertError("permission", method, params, message: "accessibility: not-requested")
        }
        XCTAssertEqual(desktop.trustRequests, 0)
        XCTAssertTrue(desktop.posted.isEmpty && desktop.raised.isEmpty)
    }

    func testReusedWindowIdWithAnotherPidIsNotFound() throws {
        try standardDesktop()
        desktop.windows[0].pid = 101
        desktop.apps[101] = AppInfo(bundleId: "com.apple.TextEdit", name: "TextEdit", regular: true)
        try assertError("not_found", "window.click", click(), message: "window changed owner")
        XCTAssertTrue(desktop.posted.isEmpty)
    }

    func testCaptureAlsoRegistersTheWindowForInput() throws {
        desktop.addWindow(10, pid: 100)
        try assertError("not_found", "window.click", click())
        _ = try result("window.capture", ["windowId": 10])
        _ = try result("window.click", click())
        XCTAssertEqual(desktop.posted.count, 1)
    }

    // MARK: - Front-window verification

    func testOcclusionByAppWindowsButNotSystemOverlays() throws {
        try standardDesktop()
        // A floating panel of another app over the click point.
        desktop.addWindow(50, pid: 500, layer: 3, bounds: CGRect(x: 450, y: 450, width: 100, height: 100))
        desktop.moveToFront(50)
        try assertError("not_frontmost", "window.click", click())
        XCTAssertTrue(desktop.posted.isEmpty)
        // Clicking beside the panel is fine.
        _ = try result("window.click", click(x: 0.1, y: 0.1))
        XCTAssertEqual(desktop.posted.count, 1)

        // Full-screen Dock and status overlays (layer >= 20) and fully transparent windows are ignored.
        desktop.windows.removeAll { $0.windowId == 50 }
        desktop.addWindow(51, pid: 501, layer: 20, bounds: CGRect(x: 0, y: 0, width: 4000, height: 3000))
        desktop.addWindow(52, pid: 502, layer: 1000, bounds: CGRect(x: 0, y: 0, width: 4000, height: 3000))
        desktop.addWindow(53, pid: 503, layer: 0, bounds: CGRect(x: 0, y: 0, width: 4000, height: 3000), alpha: 0)
        for id: UInt32 in [53, 52, 51] { desktop.moveToFront(id) }
        _ = try result("window.click", click())
        XCTAssertEqual(desktop.posted.count, 2)
    }

    func testKeyboardFocusMustBeOnTheTargetWindow() throws {
        try standardDesktop()
        desktop.focusOverride = FocusedWindow(pid: 200, windowId: 20)
        desktop.raiseMovesToFront = false
        try assertError("not_frontmost", "window.type", ["windowId": 10, "text": "hi"])
        desktop.focusOverride = FocusedWindow(pid: 100, windowId: nil)
        try assertError("not_frontmost", "window.key", ["windowId": 10, "key": "a"])
        desktop.focusOverride = FocusedWindow(pid: 100, windowId: 11)
        try assertError("not_frontmost", "window.scroll", ["windowId": 10, "dy": 10])
        XCTAssertTrue(desktop.posted.isEmpty)
        desktop.focusOverride = FocusedWindow(pid: 100, windowId: 10)
        _ = try result("window.type", ["windowId": 10, "text": "hi"])
        XCTAssertEqual(desktop.posted, [.text("hi")])
    }

    func testRaisesABackgroundWindowFirst() throws {
        try standardDesktop()
        _ = try result("window.key", ["windowId": 20, "key": "pagedown"])
        XCTAssertEqual(desktop.raised, [20])
        XCTAssertEqual(desktop.windows.first?.windowId, 20)
        XCTAssertEqual(desktop.posted, [.key(code: 121, modifiers: [], numericPad: false, function: true)])
    }

    // MARK: - Re-checks between units

    func testOwnEventsAreNotUserActivity() throws {
        try standardDesktop()
        // Three units; each post updates the HID idle time, as real posted events do.
        _ = try result("window.type", ["windowId": 10, "text": .string(String(repeating: "x", count: 45))])
        XCTAssertEqual(desktop.posted.count, 3)
        // Right after our own post, a new request still proceeds.
        _ = try result("window.key", ["windowId": 10, "key": "return"])
        XCTAssertEqual(desktop.posted.count, 4)
    }

    func testUserInputDuringASequenceStopsIt() throws {
        try standardDesktop()
        let fake = desktop!
        fake.onSleep = { [unowned fake] seconds in
            guard seconds == WindowService.Tuning.unitDelay else { return }
            fake.clock += 0.5
            fake.lastHIDEvent = fake.clock  // the user moved the mouse 0.5 s after our post
        }
        try assertError("user_active", "window.type", ["windowId": 10, "text": .string(String(repeating: "y", count: 30))])
        XCTAssertEqual(desktop.posted, [.text(String(repeating: "y", count: 20))])
    }

    func testFocusOrStateChangeDuringASequenceStopsIt() throws {
        try standardDesktop()
        let text: JSONValue = .string(String(repeating: "z", count: 60))
        let fake = desktop!

        desktop.onPost = { [unowned fake] _ in fake.moveToFront(20) }
        try assertError("not_frontmost", "window.type", ["windowId": 10, "text": text])
        XCTAssertEqual(desktop.posted.count, 1)

        desktop.moveToFront(10)
        desktop.onPost = { [unowned fake] _ in fake.secureInput = true }
        try assertError("secure_input", "window.type", ["windowId": 10, "text": text])
        XCTAssertEqual(desktop.posted.count, 2)

        desktop.secureInput = false
        desktop.onPost = { [unowned fake] _ in fake.windows.removeAll { $0.windowId == 10 } }
        try assertError("not_found", "window.type", ["windowId": 10, "text": text])
        XCTAssertEqual(desktop.posted.count, 3)

        desktop.onPost = nil
        desktop.addWindow(10, pid: 100, bundleId: "com.apple.TextEdit")
        desktop.moveToFront(10)
        desktop.onPost = { [unowned fake] _ in fake.trusted = false }
        try assertError("permission", "window.type", ["windowId": 10, "text": text])
        XCTAssertEqual(desktop.posted.count, 4)
    }

    func testUnitsArePacedAndReportCurrentBounds() throws {
        try standardDesktop()
        let fake = desktop!
        fake.onPost = { [unowned fake] _ in fake.windows[0].bounds.origin.x += 10 }
        let response = try result("window.type", ["windowId": 10, "text": "a\nb"])
        XCTAssertEqual(desktop.posted.count, 3)
        XCTAssertEqual(desktop.sleeps.filter { $0 == WindowService.Tuning.unitDelay }.count, 2)
        XCTAssertEqual(response["bounds"]?["x"], 130)
    }

    // MARK: - Text

    func testTextChunking() throws {
        let ret = InputUnit.key(code: 36, modifiers: [], numericPad: false, function: false)
        let tab = InputUnit.key(code: 48, modifiers: [], numericPad: false, function: false)
        XCTAssertEqual(try WindowService.textUnits("hello"), [.text("hello")])
        XCTAssertEqual(try WindowService.textUnits(String(repeating: "a", count: 45)),
                       [.text(String(repeating: "a", count: 20)), .text(String(repeating: "a", count: 20)), .text("aaaaa")])
        XCTAssertEqual(try WindowService.textUnits("a\nb\tc\r\nd"), [.text("a"), ret, .text("b"), tab, .text("c"), ret, .text("d")])
        // A character is never split across events: 19 ASCII + one 2-unit emoji does not fit in 20.
        let emoji = "😀"
        XCTAssertEqual(try WindowService.textUnits(String(repeating: "a", count: 19) + emoji),
                       [.text(String(repeating: "a", count: 19)), .text(emoji)])
        let family = "👨‍👩‍👧‍👦"
        XCTAssertEqual(try WindowService.textUnits(family + family), [.text(family), .text(family)])
        XCTAssertEqual(try WindowService.textUnits(String(repeating: "é", count: 500)).count, 25)

        for bad in ["", String(repeating: "a", count: 501), "bell\u{7}", "esc\u{1B}[0m", "del\u{7F}",
                    "e" + String(repeating: "\u{301}", count: 25)] {
            XCTAssertThrowsError(try WindowService.textUnits(bad), bad.debugDescription)
        }
    }

    func testTypeValidation() throws {
        try standardDesktop()
        for bad: JSONValue in [
            ["windowId": 10, "text": ""], ["windowId": 10, "text": 5], ["windowId": 10],
            ["windowId": 10, "text": .string(String(repeating: "a", count: 501))], ["windowId": 10, "text": "a", "delayMs": 5],
        ] {
            try assertError("invalid_params", "window.type", bad)
        }
        XCTAssertTrue(desktop.posted.isEmpty)
    }

    // MARK: - Keys

    func testKeyAllowlist() throws {
        for key in ["return", "tab", "escape", "delete", "space", "up", "down", "left", "right", "pageup", "pagedown",
                    "home", "end"] + "abcdefghijklmnopqrstuvwxyz0123456789".map(String.init) {
            XCTAssertNoThrow(try KeyPolicy.keyCode(for: key, modifiers: []), key)
        }
        XCTAssertEqual(KeyPolicy.namedKeys.count + KeyPolicy.characterKeys.count, 13 + 36)
        XCTAssertEqual(Set(KeyPolicy.characterKeys.values).count, 36, "distinct key codes")
        for key in ["A", "f1", "", "enter", "backspace", "forwarddelete", "`", ",", "Return", "a ", "ab", "fn", "capslock"] {
            XCTAssertThrowsError(try KeyPolicy.keyCode(for: key, modifiers: []), key)
        }
    }

    func testKeyCombinations() throws {
        let allowed: [(String, Set<KeyModifier>)] = [
            ("w", [.cmd]), ("c", [.cmd]), ("v", [.cmd]), ("z", [.cmd, .shift]), ("a", [.cmd]), ("tab", [.shift]),
            ("left", [.option]), ("left", [.cmd]), ("return", [.cmd]), ("escape", []), ("f", [.control, .cmd]),
            ("3", [.cmd]), ("space", [.shift]), ("space", [.option]), ("t", [.cmd, .shift]), ("q", [.option]),
            ("d", [.cmd]), ("escape", [.cmd]),
        ]
        for (key, modifiers) in allowed {
            XCTAssertNoThrow(try KeyPolicy.keyCode(for: key, modifiers: modifiers), "\(modifiers) \(key)")
        }
        let refused: [(String, Set<KeyModifier>)] = [
            ("q", [.cmd]), ("q", [.cmd, .shift]), ("q", [.cmd, .option]), ("q", [.cmd, .control]), ("q", [.cmd, .shift, .option]),
            ("escape", [.cmd, .option]), ("escape", [.cmd, .option, .shift]),
            ("a", [.control, .option, .cmd]), ("return", [.control, .option, .cmd, .shift]),
            ("tab", [.cmd]), ("tab", [.cmd, .shift]), ("space", [.cmd]), ("space", [.control]), ("space", [.cmd, .option]),
            ("left", [.control]), ("up", [.control]), ("down", [.control, .shift]), ("right", [.control]),
            ("3", [.cmd, .shift]), ("4", [.cmd, .shift]), ("5", [.cmd, .shift]), ("6", [.cmd, .shift]),
            ("h", [.cmd]), ("h", [.cmd, .option]), ("m", [.cmd]), ("m", [.cmd, .option]), ("d", [.cmd, .option]),
        ]
        for (key, modifiers) in refused {
            XCTAssertThrowsError(try KeyPolicy.keyCode(for: key, modifiers: modifiers), "\(modifiers) \(key)")
        }
    }

    func testKeyMethodPostsModifiersAndImplicitFlags() throws {
        try standardDesktop()
        _ = try result("window.key", ["windowId": 10, "key": "z", "modifiers": ["shift", "cmd"]])
        XCTAssertEqual(desktop.posted.last, .key(code: 6, modifiers: [.cmd, .shift], numericPad: false, function: false))
        _ = try result("window.key", ["windowId": 10, "key": "left", "modifiers": ["option"]])
        XCTAssertEqual(desktop.posted.last, .key(code: 123, modifiers: [.option], numericPad: true, function: true))
        _ = try result("window.key", ["windowId": 10, "key": "w", "modifiers": ["cmd"]])
        XCTAssertEqual(desktop.posted.count, 3)

        for bad: JSONValue in [
            ["windowId": 10, "key": "q", "modifiers": ["cmd"]], ["windowId": 10, "key": "escape", "modifiers": ["cmd", "option"]],
            ["windowId": 10, "key": "a", "modifiers": ["control", "option", "cmd"]],
            ["windowId": 10, "key": "a", "modifiers": ["cmd", "cmd"]], ["windowId": 10, "key": "a", "modifiers": ["fn"]],
            ["windowId": 10, "key": "a", "modifiers": ["Cmd"]], ["windowId": 10, "key": "a", "modifiers": "cmd"],
            ["windowId": 10, "key": "a", "modifiers": nil], ["windowId": 10, "key": "f5"], ["windowId": 10],
            ["windowId": 10, "key": "a", "modifiers": ["cmd", "shift", "option", "control", "cmd"]],
        ] {
            try assertError("invalid_params", "window.key", bad)
        }
        XCTAssertEqual(desktop.posted.count, 3)
    }

    // MARK: - Scroll

    func testScroll() throws {
        try standardDesktop()
        _ = try result("window.scroll", ["windowId": 10, "dy": 300])
        XCTAssertEqual(desktop.posted.last, .scroll(point: CGPoint(x: 500, y: 500), dx: 0, dy: 300))
        _ = try result("window.scroll", ["windowId": 10, "dx": -2000, "dy": 2000])
        XCTAssertEqual(desktop.posted.last, .scroll(point: CGPoint(x: 500, y: 500), dx: -2000, dy: 2000))
        for bad: JSONValue in [
            ["windowId": 10], ["windowId": 10, "dx": 0, "dy": 0], ["windowId": 10, "dy": 2001], ["windowId": 10, "dx": -2001],
            ["windowId": 10, "dy": .double(1.5)], ["windowId": 10, "dy": "5"], ["windowId": 10, "dy": 5, "units": "line"],
        ] {
            try assertError("invalid_params", "window.scroll", bad)
        }
        XCTAssertEqual(desktop.posted.count, 2)
    }

    // MARK: - Real backends stay untouched by invalid requests

    func testRealBackendsAreNeverReachedByInvalidParams() throws {
        // Default (real) backends: parameter validation fails first, so no OS call, prompt or event.
        let real = try greeted(Session(config: sandbox.config))
        for (method, params) in [
            ("window.click", ["windowId": 1, "x": 2, "y": 0] as JSONValue),
            ("window.type", ["windowId": 1, "text": ""]),
            ("window.key", ["windowId": 1, "key": "q", "modifiers": ["cmd"]]),
            ("window.scroll", ["windowId": 1, "dx": 0, "dy": 0]),
            ("window.capture", ["windowId": 0]),
            ("windows.list", ["extra": 1]),
            ("notes.search", ["query": ""]),
            ("mail.createDraft", ["to": [], "subject": "", "body": ""]),
        ] {
            let request: JSONValue = ["id": "1", "method": .string(method), "params": params]
            guard case .reply(let data) = real.handle(frame: try request.encoded()) else { return XCTFail() }
            XCTAssertEqual(try JSONValue.parse(data)["error"]?["code"], "invalid_params", method)
        }
    }
}
