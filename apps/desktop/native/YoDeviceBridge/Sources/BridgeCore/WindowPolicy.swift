import CoreGraphics
import Foundation

/// Apps whose windows are never listed, captured or controlled. This is the single source of truth;
/// PROTOCOL.md mirrors it. Matching is on the bundle identifier, case-insensitively. A window whose
/// process has no bundle identifier is also denied (fail closed), as are the helper's own process
/// and its parent (Yo itself, including an unbundled development Electron).
///
/// The list covers general execution surfaces (terminals, script editors, IDEs, developer consoles),
/// system settings and security UI, password managers, Yo itself and T3 Code. It is a floor, not a
/// semantic guarantee: an allowed app (for example Finder) can still open a denied app, but the
/// denied app's windows can then never be targeted, and focus moving to it stops every input method
/// with `not_frontmost`.
public enum AppDenyList {
    /// Exact bundle identifiers, stored lowercased.
    public static let bundleIds: Set<String> = Set([
        // Terminals
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "dev.warp.Warp-Stable",
        "com.mitchellh.ghostty",
        "io.alacritty",
        "net.kovidgoyal.kitty",
        // System settings and security UI
        "com.apple.systempreferences",
        "com.apple.Settings",
        "com.apple.keychainaccess",
        "com.apple.loginwindow",
        "com.apple.SecurityAgent",
        // Script and automation editors, system inspection
        "com.apple.ScriptEditor2",
        "com.apple.Automator",
        "com.apple.ActivityMonitor",
        "com.apple.Console",
        // IDEs
        "com.apple.dt.Xcode",
        "com.microsoft.VSCode",
        "com.todesktop.230313mzl4w4u92",  // Cursor
        // Password managers
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.bitwarden.desktop",
        "com.apple.Passwords",
        // Yo itself
        "dev.yo.app",
    ].map { $0.lowercased() })

    /// Any bundle identifier with one of these prefixes (lowercased) is denied: Yo's own helper apps.
    public static let prefixes: [String] = ["dev.yo.app."]

    /// Any bundle identifier containing one of these (lowercased) is denied: T3 Code in all its builds.
    public static let substrings: [String] = ["t3code", "t3.code", "t3tools"]

    public static func isDenied(bundleId: String?) -> Bool {
        guard let bundleId, !bundleId.isEmpty else { return true }
        let lower = bundleId.lowercased()
        return bundleIds.contains(lower) || prefixes.contains(where: lower.hasPrefix)
            || substrings.contains(where: lower.contains)
    }
}

public enum KeyModifier: String, CaseIterable, Sendable, Comparable {
    case cmd, shift, option, control

    public static func < (a: KeyModifier, b: KeyModifier) -> Bool {
        allCases.firstIndex(of: a)! < allCases.firstIndex(of: b)!
    }
}

/// `window.key` allowlist. Key codes are macOS virtual key codes for the ANSI layout positions
/// (`kVK_*`), so on other layouts a letter is the key at that physical position.
public enum KeyPolicy {
    public static let namedKeys: [String: UInt16] = [
        "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "pageup": 116, "end": 119, "pagedown": 121,
    ]

    public static let characterKeys: [String: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
        "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
        "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40,
        "n": 45, "m": 46,
    ]

    static let arrows: Set<String> = ["left", "right", "up", "down"]
    static let navigation: Set<String> = ["home", "end", "pageup", "pagedown"]

    /// Returns the virtual key code, or throws `invalid_params` for a key outside the allowlist or a
    /// refused combination. Refused combinations leave the target window or reach system-wide
    /// surfaces (app switching, Spotlight, Force Quit, quitting, log out, lock, Spaces, screenshots).
    public static func keyCode(for key: String, modifiers: Set<KeyModifier>) throws(BridgeError) -> UInt16 {
        guard let code = namedKeys[key] ?? characterKeys[key] else {
            throw BridgeError.invalidParams("key is not allowed")
        }
        if let reason = refusal(key: key, modifiers: modifiers) {
            throw BridgeError.invalidParams("key combination is not allowed: \(reason)")
        }
        return code
    }

    /// nil when allowed, else a short fixed reason.
    static func refusal(key: String, modifiers m: Set<KeyModifier>) -> String? {
        let cmd = m.contains(.cmd), option = m.contains(.option), control = m.contains(.control)
        let shift = m.contains(.shift)
        if cmd && option && control { return "control+option+cmd" }
        if cmd && key == "q" { return "quit or log out" }
        if cmd && option && key == "escape" { return "force quit" }
        if cmd && key == "tab" { return "app switcher" }
        if (cmd || control) && key == "space" { return "spotlight or input source" }
        if control && arrows.contains(key) { return "spaces or mission control" }
        if cmd && shift && ["3", "4", "5", "6"].contains(key) { return "screenshot" }
        if cmd && (key == "h" || key == "m") { return "hide or minimize" }
        if cmd && option && key == "d" { return "dock" }
        return nil
    }

    /// Extra event flags a physical keyboard sets for these keys.
    public static func implicitFlags(for key: String) -> (numericPad: Bool, function: Bool) {
        if arrows.contains(key) { return (true, true) }
        if navigation.contains(key) { return (false, true) }
        return (false, false)
    }
}

/// Coordinate conventions for the window input methods.
public enum WindowGeometry {
    /// Windows smaller than this (points) are not listed or targetable.
    public static let minSize = CGSize(width: 80, height: 60)

    /// Windows at or above the Dock level (kCGDockWindowLevel = 20) are system chrome or overlays
    /// (Dock, menu bar, status items, notch/dictation overlays) that are usually click-through and
    /// cover the whole screen, so the occlusion check ignores them. Layers 0..<20 are app windows,
    /// floating panels, modal panels and utility windows, which do intercept clicks.
    public static let occlusionLayers = 0..<20

    /// Converts fractions of the window (`x`, `y` in [0, 1], origin top-left) to global display points
    /// (CGWindow / CGEvent space: origin at the top-left of the main display, y down; other displays
    /// may have negative or large offsets). The far edge maps to the last point inside the window.
    public static func point(fractionX x: Double, fractionY y: Double, in bounds: CGRect) throws(BridgeError) -> CGPoint {
        guard (0...1).contains(x), (0...1).contains(y) else { throw BridgeError.invalidParams("x and y must be in [0, 1]") }
        guard bounds.width >= 1, bounds.height >= 1 else { throw BridgeError.invalidParams("point is outside the window") }
        let px = bounds.minX + min(x * bounds.width, bounds.width - 1)
        let py = bounds.minY + min(y * bounds.height, bounds.height - 1)
        let point = CGPoint(x: px, y: py)
        guard bounds.contains(point) else { throw BridgeError.invalidParams("point is outside the window") }
        return point
    }

    public static func center(of bounds: CGRect) -> CGPoint {
        CGPoint(x: bounds.minX + (bounds.width / 2).rounded(.down), y: bounds.minY + (bounds.height / 2).rounded(.down))
    }
}
