import SwiftUI

/// Lightweight ring chart — no Swift Charts dependency. Renders a circular
/// progress arc with a target tick mark. Built with `Canvas` for crisp
/// rendering at any size and easy theming with the gold accent.
public struct KpiRing: View {
    public let progress: Double          // 0.0 ... ∞ (1.0 = 100% of target)
    public let label: String
    public let primaryText: String
    public let secondaryText: String?

    public init(progress: Double, label: String, primaryText: String, secondaryText: String? = nil) {
        self.progress = max(0, progress)
        self.label = label
        self.primaryText = primaryText
        self.secondaryText = secondaryText
    }

    public var body: some View {
        VStack(spacing: Theme.Spacing.sm) {
            ZStack {
                Circle()
                    .stroke(Theme.Color.surfaceBorder, lineWidth: 8)

                Circle()
                    .trim(from: 0, to: min(progress, 1.0))
                    .stroke(
                        Theme.Color.accent,
                        style: StrokeStyle(lineWidth: 8, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))

                // Overage arc (progress > 100%) in a lighter shade.
                if progress > 1.0 {
                    Circle()
                        .trim(from: 0, to: min(progress - 1.0, 1.0))
                        .stroke(
                            Theme.Color.success,
                            style: StrokeStyle(lineWidth: 8, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))
                }

                VStack(spacing: 2) {
                    Text(primaryText)
                        .font(Theme.Font.title())
                        .foregroundStyle(Theme.Color.textPrimary)
                    if let secondary = secondaryText {
                        Text(secondary)
                            .font(Theme.Font.caption())
                            .foregroundStyle(Theme.Color.textSecondary)
                    }
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: 120)

            Eyebrow(label)
        }
    }
}
