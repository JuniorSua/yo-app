import CoreGraphics
import Foundation

/// Selected-window observation and control: parameter validation, the deny list, eligibility,
/// and the precondition chain that runs immediately before every input unit. OS access goes
/// through the injected DesktopBackends.
final class WindowService {
    enum Tuning {
        /// The user counts as active when the last keyboard/mouse event is newer than this.
        static let idleSeconds: TimeInterval = 1.5
        /// HID events up to this long after the helper's own last post are attributed to it.
        static let ownEventTolerance: TimeInterval = 0.2
        /// After raising, the front check is retried this many times, `pollInterval` apart.
        static let activationPolls = 20
        static let pollInterval: TimeInterval = 0.05
        /// Pause between consecutive units of one request so the target can process them.
        static let unitDelay: TimeInterval = 0.015
        static let textChunkUTF16 = 20
        static let maxTextCharacters = 500
        static let maxTextBytes = 8000
        static let maxScroll = 2000
        static let captureWidths = 320...2560
        static let defaultCaptureWidth = 1600
    }

    private enum Eligibility {
        case eligible(AppInfo)
        case denied
        case ineligible
    }

    private enum Anchor {
        case fraction(Double, Double)
        case center
    }

    private let backends: DesktopBackends
    private let excludedPids: Set<Int32>
    /// windowId → pid for every window returned by `windows.list` or `window.capture` in this session.
    /// Input is only accepted for these windows, and only while the window still has that pid.
    private var known: [UInt32: Int32] = [:]
    /// Uptime of the helper's most recent posted unit.
    private var lastPost: TimeInterval?

    init(backends: DesktopBackends, excludedPids: Set<Int32>) {
        self.backends = backends
        self.excludedPids = excludedPids
    }

    private var windows: WindowServerBackend { backends.windows }
    private var accessibility: AccessibilityBackend { backends.accessibility }
    private var activity: UserActivityBackend { backends.activity }

    // MARK: - permissions.request

    /// nil for a kind this service does not own.
    func requestPermission(kind: String) -> AccessStatus? {
        switch kind {
        case "accessibility":
            if accessibility.isTrusted() { return .granted }
            return accessibility.requestTrust() ? .granted : .notRequested
        case "screenRecording":
            if windows.screenRecordingGranted() { return .granted }
            return windows.requestScreenRecording() ? .granted : .notRequested
        default:
            return nil
        }
    }

    // MARK: - windows.list

    func list(_ params: inout Params) throws(BridgeError) -> JSONValue {
        try params.finish()
        try requireScreenRecording()
        var listed: [UInt32: Int32] = [:]
        var result: [JSONValue] = []
        for window in windows.onScreenWindows() {
            guard case .eligible(let app) = classify(window) else { continue }
            listed[window.windowId] = window.pid
            result.append([
                "windowId": .int(Int64(window.windowId)), "pid": .int(Int64(window.pid)),
                "bundleId": .string(app.bundleId ?? ""), "appName": .string(app.name),
                "title": .string(window.title ?? ""), "bounds": Self.json(window.bounds), "onScreen": true,
            ])
        }
        known = listed
        return ["windows": .array(result)]
    }

    // MARK: - window.capture

    func capture(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let windowId = try Self.windowId(&params)
        let maxWidth = try params.int("maxWidth", default: Tuning.defaultCaptureWidth)
        try params.finish()
        guard Tuning.captureWidths.contains(maxWidth) else { throw BridgeError.invalidParams("maxWidth must be 320...2560") }

        try requireScreenRecording()
        // Re-validated right before capturing: still on screen, eligible, not denied.
        let (window, _) = try target(windowId, in: windows.onScreenWindows())
        let image = try backends.capture.capture(windowId: windowId, maxPixelWidth: maxWidth)
        known[windowId] = window.pid
        return [
            "pngBase64": .string(image.png.base64EncodedString()), "width": .int(Int64(image.width)),
            "height": .int(Int64(image.height)), "scale": .double(Double(image.width) / window.bounds.width),
            "bounds": Self.json(window.bounds), "title": .string(window.title ?? ""),
        ]
    }

    // MARK: - Input methods

    func click(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let windowId = try Self.windowId(&params)
        let x = try params.number("x")
        let y = try params.number("y")
        let buttonName = try params.string("button", default: "left", maxBytes: 16)
        let count = try params.int("count", default: 1)
        try params.finish()
        guard (0...1).contains(x), (0...1).contains(y) else { throw BridgeError.invalidParams("x and y must be in [0, 1]") }
        guard let button = MouseButton(rawValue: buttonName) else { throw BridgeError.invalidParams("button must be left or right") }
        guard count == 1 || count == 2 else { throw BridgeError.invalidParams("count must be 1 or 2") }
        return try perform(windowId, anchor: .fraction(x, y), steps: [{ .click(point: $0, button: button, count: count) }])
    }

    func type(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let windowId = try Self.windowId(&params)
        let text = try params.string("text", maxBytes: Tuning.maxTextBytes)
        try params.finish()
        let units = try Self.textUnits(text)
        return try perform(windowId, anchor: .center, steps: units.map { unit in { _ in unit } })
    }

    func key(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let windowId = try Self.windowId(&params)
        let key = try params.string("key", maxBytes: 16)
        let names = try params.stringArray("modifiers", default: [], minCount: 0, maxCount: 4, maxBytes: 16)
        try params.finish()
        var modifiers = Set<KeyModifier>()
        for name in names {
            guard let modifier = KeyModifier(rawValue: name) else {
                throw BridgeError.invalidParams("modifiers must be cmd, shift, option or control")
            }
            guard modifiers.insert(modifier).inserted else { throw BridgeError.invalidParams("duplicate modifier") }
        }
        let code = try KeyPolicy.keyCode(for: key, modifiers: modifiers)
        let flags = KeyPolicy.implicitFlags(for: key)
        let unit = InputUnit.key(code: code, modifiers: modifiers.sorted(), numericPad: flags.numericPad, function: flags.function)
        return try perform(windowId, anchor: .center, steps: [{ _ in unit }])
    }

    func scroll(_ params: inout Params) throws(BridgeError) -> JSONValue {
        let windowId = try Self.windowId(&params)
        let dx = try params.int("dx", default: 0)
        let dy = try params.int("dy", default: 0)
        try params.finish()
        guard abs(dx) <= Tuning.maxScroll, abs(dy) <= Tuning.maxScroll else {
            throw BridgeError.invalidParams("dx and dy must be within ±2000")
        }
        guard dx != 0 || dy != 0 else { throw BridgeError.invalidParams("dx or dy must be non-zero") }
        return try perform(windowId, anchor: .center, steps: [{ .scroll(point: $0, dx: Int32(dx), dy: Int32(dy)) }])
    }

    /// Splits text into units: runs of at most 20 UTF-16 code units (never splitting a character),
    /// with line breaks posted as the Return key and tabs as the Tab key.
    static func textUnits(_ text: String) throws(BridgeError) -> [InputUnit] {
        guard !text.isEmpty else { throw BridgeError.invalidParams("text must not be empty") }
        guard text.count <= Tuning.maxTextCharacters else { throw BridgeError.invalidParams("text exceeds 500 characters") }
        var units: [InputUnit] = []
        var chunk = ""
        var chunkLength = 0
        func flush() {
            if !chunk.isEmpty { units.append(.text(chunk)) }
            chunk = ""
            chunkLength = 0
        }
        for character in text {
            if character == "\n" || character == "\r" || character == "\r\n" {
                flush()
                units.append(.key(code: KeyPolicy.namedKeys["return"]!, modifiers: [], numericPad: false, function: false))
                continue
            }
            if character == "\t" {
                flush()
                units.append(.key(code: KeyPolicy.namedKeys["tab"]!, modifiers: [], numericPad: false, function: false))
                continue
            }
            if character.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) {
                throw BridgeError.invalidParams("text contains a control character")
            }
            let length = character.utf16.count
            guard length <= Tuning.textChunkUTF16 else { throw BridgeError.invalidParams("text contains an unsupported character") }
            if chunkLength + length > Tuning.textChunkUTF16 { flush() }
            chunk.append(character)
            chunkLength += length
        }
        flush()
        return units
    }

    /// Precondition order, enforced before each unit (nothing is posted when a check fails):
    /// a) Accessibility trusted, b) window still listed with the same pid and not denied,
    /// c) screen unlocked and secure input off, d) user idle, e) target raised (first unit only,
    /// when needed) and verified as the focused window and the top window at the point,
    /// f) point inside the window.
    private func perform(_ windowId: UInt32, anchor: Anchor, steps: [(CGPoint) -> InputUnit]) throws(BridgeError) -> JSONValue {
        var current = try checkPreconditions(windowId)
        let initialPoint = try point(anchor, in: current.bounds)
        if !isFront(current, at: initialPoint) {
            guard accessibility.bringToFront(current) else { throw BridgeError(.notFrontmost, "window cannot be raised") }
            var raised = false
            for _ in 0..<Tuning.activationPolls {
                activity.sleep(Tuning.pollInterval)
                guard let refreshed = windows.onScreenWindows().first(where: { $0.windowId == windowId }) else { break }
                let refreshedPoint = try point(anchor, in: refreshed.bounds)
                if isFront(refreshed, at: refreshedPoint) {
                    raised = true
                    break
                }
            }
            guard raised else { throw BridgeError(.notFrontmost, "window is not the focused front window") }
        }
        for (index, step) in steps.enumerated() {
            if index > 0 { activity.sleep(Tuning.unitDelay) }
            current = try checkPreconditions(windowId)
            let target = try point(anchor, in: current.bounds)
            guard isFront(current, at: target) else { throw BridgeError(.notFrontmost, "window is not the focused front window") }
            try backends.input.post(step(target))
            lastPost = activity.uptime()
        }
        let bounds = windows.onScreenWindows().first(where: { $0.windowId == windowId })?.bounds ?? current.bounds
        return ["ok": true, "bounds": Self.json(bounds)]
    }

    /// Checks a) to d) and returns the window's current state.
    private func checkPreconditions(_ windowId: UInt32) throws(BridgeError) -> WindowInfo {
        guard accessibility.isTrusted() else { throw PIMService.permission("accessibility", .notRequested) }
        let (window, _) = try target(windowId, in: windows.onScreenWindows())
        guard let pid = known[windowId] else { throw BridgeError(.notFound, "window was not listed in this session") }
        guard pid == window.pid else { throw BridgeError(.notFound, "window changed owner") }
        if activity.screenLocked() { throw BridgeError(.secureInput, "screen is locked") }
        if activity.secureInputEnabled() { throw BridgeError(.secureInput, "secure keyboard entry is on") }
        let idle = activity.secondsSinceLastInput()
        if idle < Tuning.idleSeconds {
            // The newest HID event may be one the helper posted. It counts as ours only when it is no
            // newer than our last post (plus a small tolerance for event delivery).
            guard let lastPost, idle + Tuning.ownEventTolerance >= activity.uptime() - lastPost else {
                throw BridgeError(.userActive, "user is using the keyboard or mouse")
            }
        }
        return window
    }

    /// e) The window has keyboard focus (Accessibility) and is the first app-level window containing `point`.
    private func isFront(_ window: WindowInfo, at point: CGPoint) -> Bool {
        let all = windows.onScreenWindows()
        guard let focused = accessibility.focusedWindow(among: all), focused.pid == window.pid,
            focused.windowId == window.windowId
        else { return false }
        let top = all.first { WindowGeometry.occlusionLayers.contains($0.layer) && $0.alpha > 0 && $0.bounds.contains(point) }
        return top?.windowId == window.windowId
    }

    /// f)
    private func point(_ anchor: Anchor, in bounds: CGRect) throws(BridgeError) -> CGPoint {
        switch anchor {
        case .fraction(let x, let y): return try WindowGeometry.point(fractionX: x, fractionY: y, in: bounds)
        case .center: return WindowGeometry.center(of: bounds)
        }
    }

    // MARK: - Helpers

    private func requireScreenRecording() throws(BridgeError) {
        guard windows.screenRecordingGranted() else { throw PIMService.permission("screenRecording", .notRequested) }
    }

    private func classify(_ window: WindowInfo) -> Eligibility {
        guard let app = windows.app(pid: window.pid) else { return .ineligible }
        if excludedPids.contains(window.pid) || AppDenyList.isDenied(bundleId: app.bundleId) { return .denied }
        guard app.regular, window.layer == 0, window.alpha > 0, window.bounds.width >= WindowGeometry.minSize.width,
            window.bounds.height >= WindowGeometry.minSize.height
        else { return .ineligible }
        return .eligible(app)
    }

    private func target(_ windowId: UInt32, in all: [WindowInfo]) throws(BridgeError) -> (WindowInfo, AppInfo) {
        guard let window = all.first(where: { $0.windowId == windowId }) else { throw BridgeError(.notFound, "window not found") }
        switch classify(window) {
        case .denied: throw BridgeError(.denied, "app is on the deny list")
        case .ineligible: throw BridgeError(.notFound, "window not found")
        case .eligible(let app): return (window, app)
        }
    }

    private static func windowId(_ params: inout Params) throws(BridgeError) -> UInt32 {
        let value = try params.int64("windowId")
        guard value >= 1, let id = UInt32(exactly: value) else { throw BridgeError.invalidParams("windowId is out of range") }
        return id
    }

    static func json(_ rect: CGRect) -> JSONValue {
        ["x": .double(rect.minX), "y": .double(rect.minY), "width": .double(rect.width), "height": .double(rect.height)]
    }
}
