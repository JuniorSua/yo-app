import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit

// Real OS implementations of the window seams. They only call the OS; every policy decision is in
// WindowService. None of these is exercised by the unit tests.

/// CGWindowList + NSRunningApplication. Without Screen Recording, window titles are nil.
public final class CGWindowServer: WindowServerBackend {
    public init() {}

    public func onScreenWindows() -> [WindowInfo] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { entry in
            guard let number = entry[kCGWindowNumber as String] as? NSNumber,
                let pid = entry[kCGWindowOwnerPID as String] as? NSNumber,
                let layer = entry[kCGWindowLayer as String] as? NSNumber,
                let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
                let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else { return nil }
            let alpha = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            return WindowInfo(
                windowId: number.uint32Value, pid: pid.int32Value, layer: layer.intValue, bounds: bounds,
                title: entry[kCGWindowName as String] as? String, alpha: alpha)
        }
    }

    public func app(pid: Int32) -> AppInfo? {
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return nil }
        return AppInfo(bundleId: app.bundleIdentifier, name: app.localizedName ?? "", regular: app.activationPolicy == .regular)
    }

    public func screenRecordingGranted() -> Bool { CGPreflightScreenCaptureAccess() }

    public func requestScreenRecording() -> Bool { CGRequestScreenCaptureAccess() }
}

/// Single-window capture with ScreenCaptureKit (`SCContentFilter(desktopIndependentWindow:)`).
/// WindowService only calls this after `CGPreflightScreenCaptureAccess()` returned true, because
/// SCShareableContent itself can prompt when access is missing.
public final class ScreenCaptureKitCapture: WindowCaptureBackend, Sendable {
    static let timeout: TimeInterval = 15

    public init() {}

    public func capture(windowId: UInt32, maxPixelWidth: Int) throws(BridgeError) -> CapturedImage {
        let waiter = Waiter<Result<CapturedImage, BridgeError>>()
        Task.detached(priority: .userInitiated) { @Sendable in
            waiter.fulfill(await ScreenCaptureKitCapture.captureAsync(windowId: windowId, maxPixelWidth: maxPixelWidth))
        }
        guard let result = waiter.wait(timeout: Self.timeout) else { throw BridgeError(.io, "capture timed out") }
        return try result.get()
    }

    private static func captureAsync(windowId: UInt32, maxPixelWidth: Int) async -> Result<CapturedImage, BridgeError> {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        } catch {
            return .failure(BridgeError(.permission, "screenRecording: not-requested"))
        }
        guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
            return .failure(BridgeError(.notFound, "window not found"))
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = CGFloat(filter.pointPixelScale)
        let rect = filter.contentRect
        let nativeWidth = max(1, Int((rect.width * scale).rounded()))
        let nativeHeight = max(1, Int((rect.height * scale).rounded()))
        let width = min(nativeWidth, maxPixelWidth)
        let height = max(1, Int((Double(nativeHeight) * Double(width) / Double(nativeWidth)).rounded()))

        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.scalesToFit = true
        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        } catch {
            return .failure(BridgeError(.io, "capture failed"))
        }
        guard let png = encodePNG(image) else { return .failure(BridgeError(.io, "image encoding failed")) }
        return .success(CapturedImage(png: png, width: image.width, height: image.height))
    }

    static func encodePNG(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.png" as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}

/// Accessibility: trust, raising a window, and the focused window.
public final class AXAccessibility: AccessibilityBackend {
    typealias GetWindowFunction = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

    /// `_AXUIElementGetWindow` (private, but stable for many releases) maps an AX window to its
    /// CGWindowID. When it is missing, windows are matched by pid, title and frame instead.
    static let getWindow: GetWindowFunction? = {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(symbol, to: GetWindowFunction.self)
    }()

    static let messagingTimeout: Float = 1.0

    public init() {}

    public func isTrusted() -> Bool { AXIsProcessTrusted() }

    public func requestTrust() -> Bool {
        AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }

    public func bringToFront(_ window: WindowInfo) -> Bool {
        let app = AXUIElementCreateApplication(window.pid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)
        guard let elements: [AXUIElement] = Self.copy(app, kAXWindowsAttribute) else { return false }
        let matches = elements.filter { Self.windowId(of: $0, pid: window.pid, candidates: [window]) == window.windowId }
        guard matches.count == 1, let element = matches.first else { return false }
        AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        NSRunningApplication(processIdentifier: window.pid)?.activate()
        AXUIElementPerformAction(element, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
        return true
    }

    public func focusedWindow(among candidates: [WindowInfo]) -> FocusedWindow? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, Self.messagingTimeout)
        guard let app: AXUIElement = Self.copy(system, kAXFocusedApplicationAttribute) else { return nil }
        var pid: pid_t = 0
        guard AXUIElementGetPid(app, &pid) == .success else { return nil }
        guard let window: AXUIElement = Self.copy(app, kAXFocusedWindowAttribute) else {
            return FocusedWindow(pid: pid, windowId: nil)
        }
        return FocusedWindow(pid: pid, windowId: Self.windowId(of: window, pid: pid, candidates: candidates))
    }

    /// The CGWindowID of an AX window: via the private lookup when present, else the single
    /// candidate of the same pid whose title and frame match.
    static func windowId(of element: AXUIElement, pid: pid_t, candidates: [WindowInfo]) -> UInt32? {
        if let getWindow {
            var id: CGWindowID = 0
            return getWindow(element, &id) == .success && id != 0 ? id : nil
        }
        guard let position: AXValue = copy(element, kAXPositionAttribute),
            let size: AXValue = copy(element, kAXSizeAttribute)
        else { return nil }
        var origin = CGPoint.zero
        var extent = CGSize.zero
        guard AXValueGetValue(position, .cgPoint, &origin), AXValueGetValue(size, .cgSize, &extent) else { return nil }
        let title: String? = copy(element, kAXTitleAttribute)
        let frame = CGRect(origin: origin, size: extent)
        let matches = candidates.filter { candidate in
            candidate.pid == pid && abs(candidate.bounds.minX - frame.minX) <= 1 && abs(candidate.bounds.minY - frame.minY) <= 1
                && abs(candidate.bounds.width - frame.width) <= 1 && abs(candidate.bounds.height - frame.height) <= 1
                && (candidate.title == nil || title == nil || candidate.title == title)
        }
        return matches.count == 1 ? matches[0].windowId : nil
    }

    private static func copy<T>(_ element: AXUIElement, _ attribute: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? T
    }
}

/// Posts CGEvents to the HID event tap from a private-state source, so keys the user is physically
/// holding are not merged into the helper's events. Every event carries `marker` in
/// `eventSourceUserData`. All events of a unit are created before the first one is posted.
public final class CGEventInput: InputBackend {
    /// "YoBridge" in ASCII.
    public static let marker: Int64 = 0x596F_4272_6964_6765

    public init() {}

    public func post(_ unit: InputUnit) throws(BridgeError) {
        guard let source = CGEventSource(stateID: .privateState) else { throw BridgeError(.io, "event source unavailable") }
        var events: [CGEvent?] = []
        switch unit {
        case .click(let point, let button, let count):
            let (down, up): (CGEventType, CGEventType) = button == .left ? (.leftMouseDown, .leftMouseUp) : (.rightMouseDown, .rightMouseUp)
            let cgButton: CGMouseButton = button == .left ? .left : .right
            events.append(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: cgButton))
            for state in 1...max(1, count) {
                for type in [down, up] {
                    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: cgButton)
                    event?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
                    events.append(event)
                }
            }
        case .key(let code, let modifiers, let numericPad, let function):
            var flags = CGEventFlags()
            for modifier in modifiers {
                switch modifier {
                case .cmd: flags.insert(.maskCommand)
                case .shift: flags.insert(.maskShift)
                case .option: flags.insert(.maskAlternate)
                case .control: flags.insert(.maskControl)
                }
            }
            if numericPad { flags.insert(.maskNumericPad) }
            if function { flags.insert(.maskSecondaryFn) }
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down)
                event?.flags = flags
                events.append(event)
            }
        case .text(let text):
            let utf16 = Array(text.utf16)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                event?.flags = []
                event?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                events.append(event)
            }
        case .scroll(let point, let dx, let dy):
            events.append(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
            // CGEvent wheel values are positive toward the top/left; the protocol's dy > 0 means down.
            let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0)
            event?.location = point
            events.append(event)
        }
        let built = events.compactMap { $0 }
        guard built.count == events.count else { throw BridgeError(.io, "event creation failed") }
        for event in built {
            event.setIntegerValueField(.eventSourceUserData, value: Self.marker)
            event.post(tap: .cghidEventTap)
        }
    }
}

/// Secure input, screen lock and HID idle time.
public final class SystemActivity: UserActivityBackend {
    static let inputTypes: [CGEventType] = [
        .keyDown, .keyUp, .flagsChanged, .mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
        .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel,
    ]

    public init() {}

    public func secureInputEnabled() -> Bool { IsSecureEventInputEnabled() }

    public func screenLocked() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
        if (session["CGSSessionScreenIsLocked"] as? Bool) == true { return true }
        return (session["kCGSSessionOnConsoleKey"] as? Bool) == false
    }

    public func secondsSinceLastInput() -> TimeInterval {
        Self.inputTypes.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0
    }

    public func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    public func sleep(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
}
