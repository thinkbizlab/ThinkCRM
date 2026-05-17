import Foundation
import SwiftUI

/// Coordinates the login network call and bridges `TokenStore` to SwiftUI so
/// views can react to sign-in / sign-out state changes without polling.
@MainActor
public final class AuthViewModel: ObservableObject {
    @Published public private(set) var session: AuthSession?
    @Published public var isSubmitting: Bool = false
    @Published public var errorMessage: String?

    public init() {
        self.session = TokenStore.shared.load()
    }

    public var isSignedIn: Bool { session != nil }

    public func signIn(tenantSlug: String, email: String, password: String) async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        let request = LoginRequest(tenantSlug: tenantSlug, email: email, password: password)
        do {
            let response: LoginResponse = try await APIClient.shared.post("auth/login", body: request)
            await finishSignIn(with: response)
        } catch let error as APIError {
            self.errorMessage = humanise(error)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    /// Drives the same finish path as password sign-in. The MS365 OAuth helper
    /// returns a `LoginResponse` with the same shape so the post-login plumbing
    /// (Keychain save, APNs registration) is unchanged.
    public func signInWithMicrosoft(tenantSlug: String) async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let response = try await MicrosoftOAuth.shared.signIn(tenantSlug: tenantSlug)
            await finishSignIn(with: response)
        } catch MicrosoftOAuthError.userCancelled {
            // User dismissed the system sheet — silent, not an error to flash.
        } catch let error as MicrosoftOAuthError {
            self.errorMessage = error.errorDescription
        } catch let error as APIError {
            // For OAuth, surface the backend's actual message instead of the
            // password-flow's generic "Sign-in failed". The backend's specific
            // reason ("No active account for…", "Token exchange failed", "Invalid
            // or expired state") is what an admin needs to diagnose.
            self.errorMessage = extractServerMessage(error) ?? humanise(error)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    /// Pull the human-readable `message` field out of the Fastify 4xx JSON body.
    /// `@fastify/sensible` returns errors like `{"statusCode":401,"error":"Unauthorized","message":"No active account for …"}`.
    private func extractServerMessage(_ error: APIError) -> String? {
        guard case .http(_, let body?) = error,
              let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let message = json["message"] as? String,
              !message.isEmpty else {
            return nil
        }
        return message
    }

    private func finishSignIn(with response: LoginResponse) async {
        let session = AuthSession(
            accessToken:  response.accessToken,
            refreshToken: response.refreshToken,
            user:         response.user
        )
        TokenStore.shared.save(session)
        self.session = session
        // Fire-and-forget APNs token registration after a successful sign-in.
        // Failure here is non-fatal — user can still use the app.
        Task.detached { await APNsRegistrar.shared.registerIfAuthorized() }
    }

    public func signOut() {
        TokenStore.shared.clear()
        session = nil
    }

    private func humanise(_ error: APIError) -> String {
        switch error {
        case .http(let status, _) where status == 401:
            return t(.loginError)
        default:
            return error.errorDescription ?? t(.loginError)
        }
    }
}
