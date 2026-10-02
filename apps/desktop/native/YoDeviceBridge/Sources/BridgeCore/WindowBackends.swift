import CoreGraphics
import Foundation

// Narrow seams over the window server, ScreenCaptureKit, Accessibility, CGEvent posting and
// system input state. The real implementations (MacWindowBackends.swift) only call the OS;
// filtering, the deny list, precondition order and error mapping live in WindowService so they
// can be tested with fakes that never touch TCC-protected APIs or post events.

/// One on-screen window as reported by CGWindowListCopyWindowInfo.
public struct WindowInfo: Equatable, Sendable {
    public var windowId: UInt32
    public var pid: Int32
    public var layer: Int
    /// Global display points: origin at the top-left of the main display, y down.
    public var bounds: CGRect
    /// nil without Screen Recording access or when the window has no title.
    public var title: String?
    public var alpha: Double

    public init(windowId: UInt32, pid: Int32, layer: Int = 0, bounds: CGRect, title: String? = nil, alpha: Double = 1) {
        self.windowId = windowId
        self.pid = pid
        self.layer = layer
        self.bounds = bounds
        self.title = title
        self.alpha = alpha
    }
}

public struct AppInfo: Equatable, Sendable {
    public var bundleId: String?
    public var name: String
    /// NSRunningApplication.activationPolicy == .regular
    public var regular: Bool

    public init(bundleId: String?, name: String, regular: Bool) {
        self.bundleId = bundleId
        self.name = name
        self.regular = regular
    }
}

public struct CapturedImage: Equatable, Sendable {
    public var png: Data
    /// Pixels.
    public var width: Int
    public var height: Int

    public init(png: Data, width: Int, height: Int) {
        self.png = png
        self.width = width
        self.height = height
    }
}

public enum MouseButton: String, Sendable {
    case left, right
}

/// The smallest unit of input. A unit is posted as a whole (every key or button that goes down
/// also goes up) and the preconditions are re-checked before each unit.
public enum InputUnit: Equatable, Sendable {
    /// Move to `point`, then `count` down/up pairs with click states 1...count.
    case click(point: CGPoint, button: MouseButton, count: Int)
    /// Key down and up with the given modifier flags.
    case key(code: UInt16, modifiers: [KeyModifier], numericPad: Bool, function: Bool)
    /// Key down and up carrying this text (at most 20 UTF-16 code units) as the event's Unicode string.
    case text(String)
    /// Move to `point`, then one pixel scroll event. `dy > 0` scrolls toward the end of the content
    /// (down), `dx > 0` toward the right.
    case scroll(point: CGPoint, dx: Int32, dy: Int32)
}

/// The window that has keyboard focus, from the Accessibility API.
public struct FocusedWindow: Equatable, Sendable {
    public var pid: Int32
    /// nil when the focused AX window cannot be mapped to exactly one CGWindowID.
    public var windowId: UInt32?

    public init(pid: Int32, windowId: UInt32?) {
        self.pid = pid
        self.windowId = windowId
    }
}

public protocol WindowServerBackend: AnyObject {
    /// Every on-screen window of every layer, front to back.
    func onScreenWindows() -> [WindowInfo]
    /// nil when the process is gone.
    func app(pid: Int32) -> AppInfo?
    /// Non-prompting.
    func screenRecordingGranted() -> Bool
    /// May show the OS prompt. Only `permissions.request` calls this.
    func requestScreenRecording() -> Bool
}

public protocol WindowCaptureBackend: AnyObject {
    /// Captures exactly one window, scaled so its width is at most `maxPixelWidth` (never upscaled).
    func capture(windowId: UInt32, maxPixelWidth: Int) throws(BridgeError) -> CapturedImage
}

public protocol AccessibilityBackend: AnyObject {
    /// Non-prompting.
    func isTrusted() -> Bool
    /// May show the OS prompt. Only `permissions.request` calls this.
    func requestTrust() -> Bool
    /// Activates the owning app and raises the AX window matching `window`. false when no single
    /// AX window matches.
    func bringToFront(_ window: WindowInfo) -> Bool
    /// The focused app's pid and focused window; `candidates` (on-screen windows) are used to map
    /// the AX window to a CGWindowID when the private lookup is unavailable.
    func focusedWindow(among candidates: [WindowInfo]) -> FocusedWindow?
}

public protocol InputBackend: AnyObject {
    /// Posts one unit to the HID event tap, tagging every event with the helper's marker.
    func post(_ unit: InputUnit) throws(BridgeError)
}

public protocol UserActivityBackend: AnyObject {
    /// IsSecureEventInputEnabled(); true when unknown.
    func secureInputEnabled() -> Bool
    /// true when the session is locked or not on the console; true when unknown.
    func screenLocked() -> Bool
    /// Seconds since the most recent keyboard or mouse event in the HID system state.
    func secondsSinceLastInput() -> TimeInterval
    /// Monotonic clock in seconds.
    func uptime() -> TimeInterval
    func sleep(_ seconds: TimeInterval)
}

/// Everything WindowService needs from the OS.
public struct DesktopBackends {
    public var windows: WindowServerBackend
    public var capture: WindowCaptureBackend
    public var accessibility: AccessibilityBackend
    public var input: InputBackend
    public var activity: UserActivityBackend

    public init(
        windows: WindowServerBackend, capture: WindowCaptureBackend, accessibility: AccessibilityBackend,
        input: InputBackend, activity: UserActivityBackend
    ) {
        self.windows = windows
        self.capture = capture
        self.accessibility = accessibility
        self.input = input
        self.activity = activity
    }

    /// The real OS backends. Constructing them calls nothing and prompts for nothing.
    public static func live() -> DesktopBackends {
        DesktopBackends(
            windows: CGWindowServer(), capture: ScreenCaptureKitCapture(), accessibility: AXAccessibility(),
            input: CGEventInput(), activity: SystemActivity())
    }
}
