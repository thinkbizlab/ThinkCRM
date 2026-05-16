import SwiftUI

/// Visual language mirrored from workselected.com — the sister brand from the
/// same parent company (Workstation Office). Black/near-black backgrounds with
/// a warm-gold accent, sharp (not rounded) corners, generous whitespace, and
/// uppercase tracking on collection-style headers. Final hex values should be
/// sampled from the live site during the polish pass; the values below are an
/// approximation that already gives the right *mood*.
public enum Theme {
    public enum Color {
        public static let backgroundPrimary  = SwiftUI.Color(hex: 0x0A0A0A)
        public static let backgroundElevated = SwiftUI.Color(hex: 0x161616)
        public static let backgroundLight    = SwiftUI.Color(hex: 0xFAFAFA)
        public static let surfaceBorder      = SwiftUI.Color(hex: 0x2A2A2A)
        public static let accent             = SwiftUI.Color(hex: 0xC9A961) // warm gold
        public static let accentMuted        = SwiftUI.Color(hex: 0x8C7341)
        public static let textPrimary        = SwiftUI.Color.white
        public static let textSecondary      = SwiftUI.Color(hex: 0xA8A8A8)
        public static let textOnLight        = SwiftUI.Color(hex: 0x111111)
        public static let success            = SwiftUI.Color(hex: 0x4ADE80)
        public static let danger             = SwiftUI.Color(hex: 0xEF4444)
    }

    public enum Font {
        /// SF Pro has full Thai glyph coverage; using the Dynamic-Type-aware
        /// `.system(_:)` overload (vs. fixed `size:`) lets the OS scale every
        /// label when the user changes Settings → Display & Brightness → Text
        /// Size. We keep the same visual *bucket* defaults — `.largeTitle`
        /// ≈ 34pt, `.title2` ≈ 22pt, `.body` = 17pt, `.footnote` = 13pt —
        /// which match the previous hard-coded sizes within ~2pt.
        public static func display() -> SwiftUI.Font { .system(.largeTitle, design: .default).weight(.bold) }
        public static func title()   -> SwiftUI.Font { .system(.title2,     design: .default).weight(.semibold) }
        public static func body()    -> SwiftUI.Font { .system(.body) }
        public static func caption() -> SwiftUI.Font { .system(.footnote) }
        public static func eyebrow() -> SwiftUI.Font { .system(.caption2,   design: .default).weight(.semibold) }
    }

    public enum Spacing {
        public static let xs:  CGFloat = 4
        public static let sm:  CGFloat = 8
        public static let md:  CGFloat = 12
        public static let lg:  CGFloat = 20
        public static let xl:  CGFloat = 32
        public static let xxl: CGFloat = 48
    }

    public enum Radius {
        public static let card:   CGFloat = 12
        public static let button: CGFloat = 8
        public static let pill:   CGFloat = 999
    }
}

// MARK: - Color hex helper

extension Color {
    /// Build a SwiftUI Color from a 0xRRGGBB integer. Keeps the design tokens
    /// readable next to the hex values they came from.
    init(hex: UInt32, alpha: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >>  8) & 0xFF) / 255.0
        let b = Double( hex        & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}

// MARK: - Buttons

/// Primary CTA — solid gold fill, white text, sharp 8pt corners. Use for the
/// dominant action on a screen (Login, Check-In, Confirm).
public struct PrimaryButtonStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.body().weight(.semibold))
            .foregroundStyle(Theme.Color.textOnLight)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.button, style: .continuous)
                    .fill(Theme.Color.accent.opacity(configuration.isPressed ? 0.8 : 1.0))
            )
    }
}

/// Secondary — 1pt border, transparent fill. Pairs with PrimaryButtonStyle.
public struct SecondaryButtonStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.body().weight(.semibold))
            .foregroundStyle(Theme.Color.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.button, style: .continuous)
                    .strokeBorder(Theme.Color.surfaceBorder, lineWidth: 1)
                    .background(Color.clear)
            )
            .opacity(configuration.isPressed ? 0.7 : 1.0)
    }
}

/// Tertiary — text + right-arrow glyph, echoing workselected.com's "ดูเพิ่มเติม →".
public struct TertiaryLinkStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.label
            Image(systemName: "arrow.right")
                .font(.system(size: 13, weight: .semibold))
        }
        .font(Theme.Font.caption().weight(.semibold))
        .foregroundStyle(Theme.Color.accent)
        .opacity(configuration.isPressed ? 0.6 : 1.0)
    }
}

// MARK: - Card

public struct CardModifier: ViewModifier {
    public func body(content: Content) -> some View {
        content
            .padding(Theme.Spacing.lg)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                    .fill(Theme.Color.backgroundElevated)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                    .strokeBorder(Theme.Color.surfaceBorder, lineWidth: 0.5)
            )
    }
}

public extension View {
    func card() -> some View { modifier(CardModifier()) }
}

// MARK: - Eyebrow header

/// UPPERCASE collection-style header used above section bodies — mirrors the
/// "MODEL-G3" / "SIHOO" treatment on workselected.com.
public struct Eyebrow: View {
    let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        // .uppercased() is a no-op on Thai script (no case), and `tracking`
        // doesn't visibly separate Thai diacritic clusters — both are
        // intentional. The header is announced as a header to VoiceOver so
        // section landmarks work even without visible styling cues.
        Text(text.uppercased())
            .font(Theme.Font.eyebrow())
            .tracking(1.2)
            .foregroundStyle(Theme.Color.textSecondary)
            .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Thai-aware line spacing

public extension View {
    /// Thai characters can stack two vowel + tone marks above the consonant
    /// baseline. SwiftUI's default line spacing for `.system` Body is fine
    /// for Latin but visually tight when those marks appear. Use this on
    /// any multi-line `Text` that may contain Thai (objectives, results,
    /// progress notes).
    func thaiAwareLineSpacing() -> some View {
        self.lineSpacing(4)
    }
}
