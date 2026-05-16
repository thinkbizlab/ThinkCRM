import Foundation

/// Centralised access to build-time configuration injected via xcconfig →
/// Info.plist. Keeping this in one place means the API base URL has exactly
/// one source of truth (project.yml → Configs/*.xcconfig → Info.plist key
/// `WorkCRMAPIBaseURL`).
public enum AppConfig {
    /// The base URL of the Fastify API, including `/api/v1`.
    public static var apiBaseURL: URL {
        guard
            let raw = Bundle.main.object(forInfoDictionaryKey: "WorkCRMAPIBaseURL") as? String,
            let url = URL(string: raw)
        else {
            // This is a build-config failure, not a runtime condition — crash
            // early so it's caught the first time someone runs the app.
            fatalError("WorkCRMAPIBaseURL is missing or malformed in Info.plist.")
        }
        return url
    }

    /// Default tenant slug shown pre-filled on LoginView. Kept here (not in a
    /// string table) because it's a build-time config more than a translation.
    public static let defaultTenantSlug = "workcrm"
}
