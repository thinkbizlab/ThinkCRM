import SwiftUI

/// Reusable bottom-sheet shown when an in-app action (check-in, selfie, voice
/// note) is blocked by a denied permission. iOS does not re-prompt for a
/// permission after the first denial — the only way to re-grant is via
/// Settings → WorkCRM, so this sheet leads the user there.
public struct PermissionDeniedSheet: View {
    public let kind: PermissionKind
    public let onDismiss: () -> Void
    @StateObject private var permissions = PermissionsManager.shared
    @Environment(\.scenePhase) private var scenePhase

    public init(kind: PermissionKind, onDismiss: @escaping () -> Void) {
        self.kind = kind
        self.onDismiss = onDismiss
    }

    public var body: some View {
        VStack(spacing: Theme.Spacing.lg) {
            Image(systemName: kind.systemImage)
                .font(.system(size: 56))
                .foregroundStyle(Theme.Color.danger)
                .padding(.top, Theme.Spacing.xl)

            Text("\(kind.title) is off")
                .font(Theme.Font.title())
                .foregroundStyle(Theme.Color.textPrimary)

            Text(kind.rationale)
                .font(Theme.Font.body())
                .foregroundStyle(Theme.Color.textSecondary)
                .multilineTextAlignment(.center)
                .thaiAwareLineSpacing()
                .padding(.horizontal, Theme.Spacing.xl)

            VStack(spacing: Theme.Spacing.sm) {
                Button("Open Settings") {
                    Task { _ = await permissions.openAppSettings() }
                }
                .buttonStyle(PrimaryButtonStyle())

                Button("Not now") { onDismiss() }
                    .buttonStyle(SecondaryButtonStyle())
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.bottom, Theme.Spacing.xl)
        }
        .frame(maxWidth: .infinity)
        .background(Theme.Color.backgroundPrimary)
        // When the user comes back from Settings the scene reactivates —
        // re-read the system permission so callers can decide whether to retry
        // the action that triggered this sheet.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { permissions.refresh() }
        }
    }
}
