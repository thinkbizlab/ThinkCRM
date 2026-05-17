import SwiftUI

/// One-time onboarding shown after a user signs in for the first time. Walks
/// through each system permission with a rationale + a button that triggers
/// the iOS prompt. Sequential pages so each prompt's context is clear.
///
/// Persisted via `UserDefaults` (`didCompleteOnboarding`); RootView consults
/// it on every render. To force the flow again during development, delete
/// the app and reinstall, or call `UserDefaults.standard.removeObject(...)`.
public struct OnboardingView: View {
    @StateObject private var permissions = PermissionsManager.shared
    @State private var pageIndex: Int = 0

    private let onComplete: () -> Void

    public init(onComplete: @escaping () -> Void) {
        self.onComplete = onComplete
    }

    private var pages: [OnboardingPage] {
        [.welcome] +
        PermissionKind.allCases.map { .permission($0) } +
        [.allDone]
    }

    private var currentPage: OnboardingPage {
        pages[min(pageIndex, pages.count - 1)]
    }

    public var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            VStack(spacing: Theme.Spacing.lg) {
                progressBar
                Spacer()
                pageBody
                Spacer()
                actionButtons
            }
            .padding(Theme.Spacing.xl)
        }
        .animation(.easeInOut(duration: 0.2), value: pageIndex)
    }

    private var progressBar: some View {
        HStack(spacing: 4) {
            ForEach(0..<pages.count, id: \.self) { i in
                Rectangle()
                    .fill(i <= pageIndex ? Theme.Color.accent : Theme.Color.surfaceBorder)
                    .frame(height: 3)
                    .clipShape(Capsule())
            }
        }
        .padding(.top, Theme.Spacing.md)
    }

    @ViewBuilder
    private var pageBody: some View {
        switch currentPage {
        case .welcome:
            VStack(spacing: Theme.Spacing.lg) {
                Image(systemName: "hand.wave.fill")
                    .font(.system(size: 72))
                    .foregroundStyle(Theme.Color.accent)
                Text("Welcome to WorkCRM")
                    .font(Theme.Font.display())
                    .foregroundStyle(Theme.Color.textPrimary)
                    .multilineTextAlignment(.center)
                Text("A few quick permissions and you'll be ready to log your first visit. You can change any of these later in Settings.")
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
                    .multilineTextAlignment(.center)
                    .thaiAwareLineSpacing()
            }

        case .permission(let kind):
            VStack(spacing: Theme.Spacing.lg) {
                Image(systemName: kind.systemImage)
                    .font(.system(size: 72))
                    .foregroundStyle(statusColor(for: kind))
                Text(kind.title)
                    .font(Theme.Font.display())
                    .foregroundStyle(Theme.Color.textPrimary)
                Text(kind.rationale)
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
                    .multilineTextAlignment(.center)
                    .thaiAwareLineSpacing()
                statusBadge(for: kind)
            }

        case .allDone:
            VStack(spacing: Theme.Spacing.lg) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 72))
                    .foregroundStyle(Theme.Color.success)
                Text("You're all set")
                    .font(Theme.Font.display())
                    .foregroundStyle(Theme.Color.textPrimary)
                Text("If you ever change your mind, open iOS Settings → WorkCRM to adjust any permission.")
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
                    .multilineTextAlignment(.center)
                    .thaiAwareLineSpacing()
            }
        }
    }

    private var actionButtons: some View {
        VStack(spacing: Theme.Spacing.md) {
            primaryButton
            if case .permission = currentPage {
                Button("Skip for now") { advance() }
                    .buttonStyle(TertiaryLinkStyle())
            }
        }
    }

    @ViewBuilder
    private var primaryButton: some View {
        switch currentPage {
        case .welcome:
            Button("Get started") { advance() }
                .buttonStyle(PrimaryButtonStyle())

        case .permission(let kind):
            if permissions.isGranted(kind) {
                Button("Continue") { advance() }
                    .buttonStyle(PrimaryButtonStyle())
            } else if permissions.isDenied(kind) {
                VStack(spacing: Theme.Spacing.sm) {
                    Button("Open Settings") {
                        Task { _ = await permissions.openAppSettings() }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    Button("Continue") { advance() }
                        .buttonStyle(SecondaryButtonStyle())
                }
            } else {
                Button("Allow \(kind.title)") {
                    Task { await request(kind) }
                }
                .buttonStyle(PrimaryButtonStyle())
            }

        case .allDone:
            Button("Start using WorkCRM") {
                UserDefaults.standard.set(true, forKey: OnboardingView.completionKey)
                onComplete()
            }
            .buttonStyle(PrimaryButtonStyle())
        }
    }

    private func request(_ kind: PermissionKind) async {
        switch kind {
        case .location:      _ = await permissions.requestLocation()
        case .camera:        _ = await permissions.requestCamera()
        case .microphone:    _ = await permissions.requestMicrophone()
        case .notifications: _ = await permissions.requestNotifications()
        }
        // Whether granted or denied, advance — both Continue and Open Settings
        // paths are now exposed on this page if the user wants to retry.
        // (The system only shows the iOS prompt once; subsequent taps would
        //  no-op silently.)
        advance()
    }

    private func advance() {
        if pageIndex < pages.count - 1 {
            pageIndex += 1
        }
    }

    private func statusColor(for kind: PermissionKind) -> Color {
        if permissions.isGranted(kind) { return Theme.Color.success }
        if permissions.isDenied(kind)  { return Theme.Color.danger }
        return Theme.Color.accent
    }

    @ViewBuilder
    private func statusBadge(for kind: PermissionKind) -> some View {
        let text: String
        let color: Color
        if permissions.isGranted(kind) {
            text = "✓ Allowed"; color = Theme.Color.success
        } else if permissions.isDenied(kind) {
            text = "Denied — open Settings to enable"; color = Theme.Color.danger
        } else {
            text = "Not asked yet"; color = Theme.Color.textSecondary
        }
        Text(text)
            .font(Theme.Font.caption().weight(.semibold))
            .foregroundStyle(color)
    }

    public static let completionKey = "WorkCRM.didCompleteOnboarding"
}

public enum OnboardingPage: Equatable, Hashable {
    case welcome
    case permission(PermissionKind)
    case allDone
}

extension PermissionKind: Hashable {}
