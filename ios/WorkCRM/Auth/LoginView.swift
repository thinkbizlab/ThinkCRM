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

                Spacer()
            }
            .padding(Theme.Spacing.xl)
        }
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
