import SwiftUI

public struct LoginView: View {
    @EnvironmentObject private var auth: AuthViewModel
    @State private var tenantSlug: String = AppConfig.defaultTenantSlug
    @State private var email: String = ""
    @State private var password: String = ""

    public init() {}

    public var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Eyebrow("WorkCRM")
                    Text(t(.loginTitle))
                        .font(Theme.Font.display())
                        .foregroundStyle(Theme.Color.textPrimary)
                }

                VStack(spacing: Theme.Spacing.md) {
                    field(t(.loginTenantSlug), text: $tenantSlug, autocapitalize: false, contentType: .organizationName)
                    field(t(.loginEmail),      text: $email,      autocapitalize: false, keyboard: .emailAddress, contentType: .username)
                    secureField(t(.loginPassword), text: $password)
                }

                if let error = auth.errorMessage {
                    Text(error)
                        .font(Theme.Font.caption())
                        .foregroundStyle(Theme.Color.danger)
                }

                Button {
                    Task {
                        await auth.signIn(
                            tenantSlug: tenantSlug.trimmingCharacters(in: .whitespaces),
                            email:      email.trimmingCharacters(in: .whitespaces).lowercased(),
                            password:   password
                        )
                    }
                } label: {
                    if auth.isSubmitting {
                        ProgressView().tint(Theme.Color.textOnLight)
                    } else {
                        Text(t(.loginCta))
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(auth.isSubmitting || email.isEmpty || password.isEmpty || tenantSlug.isEmpty)

                // ── Divider between password sign-in and the OAuth path ────────
                HStack(spacing: Theme.Spacing.sm) {
                    Rectangle().fill(Theme.Color.surfaceBorder).frame(height: 0.5)
                    Text("or").font(Theme.Font.caption()).foregroundStyle(Theme.Color.textSecondary)
                    Rectangle().fill(Theme.Color.surfaceBorder).frame(height: 0.5)
                }

                Button {
                    Task {
                        await auth.signInWithMicrosoft(
                            tenantSlug: tenantSlug.trimmingCharacters(in: .whitespaces)
                        )
                    }
                } label: {
                    HStack(spacing: Theme.Spacing.sm) {
                        // Microsoft "windowed" mark, drawn inline to avoid bundling an asset.
                        // Four equal coloured squares — matches Microsoft's brand guidelines
                        // closely enough for an internal CRM. Each colour is hard-coded so
                        // the mark renders correctly in both light and dark backgrounds.
                        msftMark
                        Text("Sign in with Microsoft")
                    }
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(auth.isSubmitting || tenantSlug.isEmpty)
                .accessibilityLabel("Sign in with Microsoft")
                .accessibilityHint("Opens the Microsoft sign-in sheet")

                Spacer()
            }
            .padding(Theme.Spacing.xl)
        }
    }

    private var msftMark: some View {
        // 16×16 grid of 4 coloured squares, 1pt gap. Inline so we don't depend
        // on an asset catalogue entry.
        let s: CGFloat = 7
        let g: CGFloat = 1
        return ZStack {
            VStack(spacing: g) {
                HStack(spacing: g) {
                    Rectangle().fill(Color(hex: 0xF25022)).frame(width: s, height: s)  // red
                    Rectangle().fill(Color(hex: 0x7FBA00)).frame(width: s, height: s)  // green
                }
                HStack(spacing: g) {
                    Rectangle().fill(Color(hex: 0x00A4EF)).frame(width: s, height: s)  // blue
                    Rectangle().fill(Color(hex: 0xFFB900)).frame(width: s, height: s)  // yellow
                }
            }
        }
        .frame(width: s * 2 + g, height: s * 2 + g)
    }

    @ViewBuilder
    private func field(_ placeholder: String, text: Binding<String>, autocapitalize: Bool, keyboard: UIKeyboardType = .default, contentType: UITextContentType? = nil) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboard)
            .textInputAutocapitalization(autocapitalize ? .sentences : .never)
            .autocorrectionDisabled(true)
            .textContentType(contentType)
            .padding(Theme.Spacing.md)
            .frame(minHeight: 48)             // tap-target floor
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.button, style: .continuous)
                    .strokeBorder(Theme.Color.surfaceBorder, lineWidth: 1)
            )
            .foregroundStyle(Theme.Color.textPrimary)
            .accentColor(Theme.Color.accent)
            .accessibilityLabel(placeholder)
    }

    @ViewBuilder
    private func secureField(_ placeholder: String, text: Binding<String>) -> some View {
        SecureField(placeholder, text: text)
            // iOS Password autofill needs `.password` content type to suggest
            // saved credentials and trigger Keychain integration.
            .textContentType(.password)
            .padding(Theme.Spacing.md)
            .frame(minHeight: 48)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.button, style: .continuous)
                    .strokeBorder(Theme.Color.surfaceBorder, lineWidth: 1)
            )
            .foregroundStyle(Theme.Color.textPrimary)
            .accentColor(Theme.Color.accent)
            .accessibilityLabel(placeholder)
    }
}
