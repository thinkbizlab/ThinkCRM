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
                    field(t(.loginTenantSlug), text: $tenantSlug, autocapitalize: false)
                    field(t(.loginEmail), text: $email, autocapitalize: false, keyboard: .emailAddress)
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
    private func field(_ placeholder: String, text: Binding<String>, autocapitalize: Bool, keyboard: UIKeyboardType = .default) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboard)
            .textInputAutocapitalization(autocapitalize ? .sentences : .never)
            .autocorrectionDisabled(true)
            .padding(Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.button, style: .continuous)
                    .strokeBorder(Theme.Color.surfaceBorder, lineWidth: 1)
            )
            .foregroundStyle(Theme.Color.textPrimary)
            .accentColor(Theme.Color.accent)
    }

    @ViewBuilder
    private func secureField(_ placeholder: String, text: Binding<String>) -> some View {
        SecureField(placeholder, text: text)
            .padding(Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.button, style: .continuous)
                    .strokeBorder(Theme.Color.surfaceBorder, lineWidth: 1)
            )
            .foregroundStyle(Theme.Color.textPrimary)
            .accentColor(Theme.Color.accent)
    }
}
