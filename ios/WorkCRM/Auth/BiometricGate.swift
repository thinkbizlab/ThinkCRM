import SwiftUI
import LocalAuthentication

/// Wraps content behind a FaceID / TouchID gate. Used on cold launch when a
/// session already exists in Keychain — we want the user to re-authenticate
/// before exposing customer data, but not re-enter their password.
public struct BiometricGate<Content: View>: View {
    @State private var unlocked = false
    @State private var error: String?
    private let content: () -> Content

    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    public var body: some View {
        Group {
            if unlocked {
                content()
            } else {
                ZStack {
                    Theme.Color.backgroundPrimary.ignoresSafeArea()
                    VStack(spacing: Theme.Spacing.lg) {
                        Image(systemName: "faceid")
                            .font(.system(size: 72))
                            .foregroundStyle(Theme.Color.accent)
                        Text("WorkCRM")
                            .font(Theme.Font.title())
                            .foregroundStyle(Theme.Color.textPrimary)
                        if let error {
                            Text(error)
                                .font(Theme.Font.caption())
                                .foregroundStyle(Theme.Color.danger)
                                .multilineTextAlignment(.center)
                        }
                        Button("Unlock") { Task { await authenticate() } }
                            .buttonStyle(PrimaryButtonStyle())
                            .padding(.horizontal, Theme.Spacing.xl)
                    }
                }
                .task { await authenticate() }
            }
        }
    }

    private func authenticate() async {
        let context = LAContext()
        var evalError: NSError?

        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &evalError) else {
            // No biometrics enrolled (or device doesn't support it) — fall
            // through to passcode rather than locking the user out. If both
            // fail we surface the error.
            return await fallbackToPasscode()
        }

        do {
            let ok = try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: "Unlock WorkCRM"
            )
            await MainActor.run { unlocked = ok }
        } catch {
            await fallbackToPasscode()
        }
    }

    private func fallbackToPasscode() async {
        let context = LAContext()
        do {
            let ok = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Unlock WorkCRM"
            )
            await MainActor.run { unlocked = ok }
        } catch {
            await MainActor.run { self.error = "Authentication failed. Try again." }
        }
    }
}
