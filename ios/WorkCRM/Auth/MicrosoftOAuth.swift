import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// Sign-in with Microsoft via the OAuth 2.0 authorization-code flow with PKCE.
///
/// The mobile flow is split across two backend endpoints so the client never
/// sees the tenant's MS365 client_secret:
///
///   1. POST /auth/oauth/ms365/mobile/begin  → returns the authorize URL the
///      client opens in ASWebAuthenticationSession. We send up a code_challenge
///      (SHA-256 of a random verifier) so Microsoft binds the code to this client.
///   2. The user signs in inside the system-presented browser; Microsoft redirects
///      to `workcrm://oauth/callback?code=…&state=…`.
///   3. The URL is delivered back to this app via the registered URL scheme;
///      ASWebAuthenticationSession's completion handler resolves with it.
///   4. POST /auth/oauth/ms365/mobile/complete with { code, state, codeVerifier,
///      tenantSlug } — the backend exchanges with Microsoft (proving possession
///      via the verifier), looks up the user by email, returns our own JWT pair.
///
/// `ASWebAuthenticationSession` is the recommended Apple API for this — it shares
/// cookies with Safari (so a previously-signed-in MS account on the device just
/// works) and presents a system Sign-In dialog the user explicitly trusts.
public enum MicrosoftOAuthError: Error, LocalizedError {
    case userCancelled
    case invalidCallback
    case backend(String)

    public var errorDescription: String? {
        switch self {
        case .userCancelled:        return "Sign-in cancelled."
        case .invalidCallback:      return "Sign-in returned an invalid response."
        case .backend(let m):       return m
        }
    }
}

@MainActor
public final class MicrosoftOAuth: NSObject {
    public static let shared = MicrosoftOAuth()
    private let redirectUri = "workcrm://oauth/callback"
    private let callbackScheme = "workcrm"

    private var presentationAnchor: ASPresentationAnchor?
    private var pendingSession: ASWebAuthenticationSession?
    private override init() { super.init() }

    /// Run the full OAuth dance and return a `LoginResponse` ready to drop into
    /// `TokenStore`. Throws on cancel or any HTTP/validation failure.
    public func signIn(tenantSlug: String) async throws -> LoginResponse {
        let verifier = Self.generateCodeVerifier()
        let challenge = Self.codeChallenge(forVerifier: verifier)

        // Step 1 — ask the backend for the authorize URL with our challenge baked in.
        let begin: OAuthBeginResponse = try await APIClient.shared.post(
            "auth/oauth/ms365/mobile/begin",
            body: OAuthBeginRequest(
                tenantSlug:    tenantSlug,
                codeChallenge: challenge,
                redirectUri:   redirectUri
            )
        )
        guard let authURL = URL(string: begin.authorizationUrl) else {
            throw MicrosoftOAuthError.backend("Invalid authorization URL from backend.")
        }

        // Step 2-3 — present the system sign-in sheet and wait for the redirect.
        let callbackURL = try await presentSession(authURL: authURL)
        guard
            let comps = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
            let code  = comps.queryItems?.first(where: { $0.name == "code" })?.value,
            let state = comps.queryItems?.first(where: { $0.name == "state" })?.value
        else {
            throw MicrosoftOAuthError.invalidCallback
        }

        // Step 4 — exchange on the backend, get our own session tokens.
        let result: LoginResponse = try await APIClient.shared.post(
            "auth/oauth/ms365/mobile/complete",
            body: OAuthCompleteRequest(
                tenantSlug:   tenantSlug,
                code:         code,
                state:        state,
                codeVerifier: verifier,
                redirectUri:  redirectUri
            )
        )
        return result
    }

    // MARK: - ASWebAuthenticationSession wrapper

    private func presentSession(authURL: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
            let session = ASWebAuthenticationSession(
                url: authURL,
                callbackURLScheme: callbackScheme
            ) { url, error in
                if let error = error as? ASWebAuthenticationSessionError {
                    cont.resume(throwing: error.code == .canceledLogin
                        ? MicrosoftOAuthError.userCancelled
                        : MicrosoftOAuthError.backend(error.localizedDescription))
                    return
                }
                if let error { cont.resume(throwing: error); return }
                guard let url else { cont.resume(throwing: MicrosoftOAuthError.invalidCallback); return }
                cont.resume(returning: url)
            }
            // Share cookies with Safari so a corporate-signed-in MS account just works.
            // Without this, the user has to re-enter MS credentials on first sign-in.
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = self
            self.pendingSession = session   // retain until completion
            if !session.start() {
                cont.resume(throwing: MicrosoftOAuthError.backend("Could not start sign-in session."))
            }
        }
    }

    // MARK: - PKCE helpers

    /// Generate a random URL-safe code verifier between 43–128 characters
    /// (per RFC 7636 §4.1). We pick 64 — comfortably above the floor and well
    /// under the ceiling, matching what most OAuth client libraries default to.
    static func generateCodeVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncoded()
    }

    /// `code_challenge = base64url(SHA256(code_verifier))` — the `S256` method.
    static func codeChallenge(forVerifier verifier: String) -> String {
        let data = Data(verifier.utf8)
        let digest = SHA256.hash(data: data)
        return Data(digest).base64URLEncoded()
    }
}

extension MicrosoftOAuth: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // Use the first foreground active scene's window. Falls back to a fresh
        // UIWindow if no scene is foregrounded — unlikely in practice but the
        // API requires a non-nil return.
        let scenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
        return scenes.first?.windows.first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}

private extension Data {
    /// Base64url encoding without padding (RFC 4648 §5), which PKCE requires.
    func base64URLEncoded() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
