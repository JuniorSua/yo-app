import SwiftUI
import UIKit

/// Yo's colors (phone/styles.css): warm paper, ink and Yo Yellow, each with its dark-mode pair.
enum Palette {
    static let bg = Color(light: 0xFAF9F6, dark: 0x1C1D20)
    static let bg2 = Color(light: 0xF3F2EE, dark: 0x222327)
    static let bg3 = Color(light: 0xECEBE6, dark: 0x2B2D31)
    static let card = Color(light: 0xFFFFFF, dark: 0x24262A)
    static let line = Color(light: 0xE7E6E0, dark: 0x2D2F33)
    static let line2 = Color(light: 0xDAD9D2, dark: 0x3A3C41)
    static let ink = Color(light: 0x1D1E1B, dark: 0xF1F0EB)
    static let fg2 = Color(light: 0x4E514B, dark: 0xC3C2BC)
    static let muted = Color(light: 0x6B6E67, dark: 0xA09F9A)
    static let faint = Color(light: 0x9A9C95, dark: 0x76756F)
    static let yellow = Color(hex: 0xFFD43B)
    static let yellow2 = Color(hex: 0xF5B800)
    static let yellowInk = Color(light: 0x7A5A06, dark: 0xFFD43B)
    static let green = Color(light: 0x2F9E5F, dark: 0x5FD08E)
    static let red = Color(light: 0xC4372B, dark: 0xFF7B6E)
    static let link = Color(light: 0x335AC8, dark: 0x8FA8FF)
    static let bubbleYo = Color(light: 0xEFEEE9, dark: 0x2B2D31)
    /// Text on Yo Yellow, which stays dark in both modes.
    static let onYellow = Color(hex: 0x1D1E1B)
    /// The amber glow under the logo and the yellow buttons.
    static let glow = Color(hex: 0xCF8615)
}

extension Color {
    init(hex: UInt32) {
        self.init(uiColor: UIColor(hex: hex))
    }

    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

extension Font {
    /// Geist (SIL Open Font License, bundled), scaled with Dynamic Type relative to `style`.
    static func geist(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body)
        -> Font {
        .custom("Geist", size: size, relativeTo: style).weight(weight)
    }

    static func geistMono(_ size: CGFloat, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom("Geist Mono", size: size, relativeTo: style)
    }
}

/// The big rounded buttons on cards and the welcome screen.
struct YoButtonStyle: ButtonStyle {
    enum Kind {
        /// Yo Yellow, for the main action.
        case primary
        /// Ink on paper.
        case ink
        /// Outlined.
        case plain
    }

    var kind: Kind = .plain
    var minHeight: CGFloat = 50

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.geist(16, .semibold))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: minHeight)
            .foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                if kind == .plain {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.line2)
                }
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var foreground: Color {
        switch kind {
        case .primary: Palette.onYellow
        case .ink: Palette.bg
        case .plain: Palette.ink
        }
    }

    private var background: Color {
        switch kind {
        case .primary: Palette.yellow
        case .ink: Palette.ink
        case .plain: Palette.card
        }
    }
}

/// A rounded card on paper, like `.card` in the PWA.
struct CardBackground: ViewModifier {
    var radius: CGFloat = 20

    func body(content: Content) -> some View {
        content
            .background(Palette.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.line))
            .shadow(color: Palette.ink.opacity(0.06), radius: 7, y: 3)
    }
}

extension View {
    func yoCard(radius: CGFloat = 20) -> some View {
        modifier(CardBackground(radius: radius))
    }
}

/// Small, consistent haptics.
@MainActor
enum Haptics {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func attention() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func failure() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}
