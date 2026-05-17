import Foundation

/// Centralised access to the API base URL.
///
/// We try the build-time-injected Info.plist value first (set via the active
/// xcconfig → `$(WORK_CRM_API_BASE_URL)` → Info.plist key `WorkCRMAPIBaseURL`).
/// If the plist value didn't substitute properly — i.e. it's still the literal
/// "$(WORK_CRM_API_BASE_URL)" — we fall through to a hardcoded URL keyed off
/// the build configuration. This is more resilient than the previous
/// `fatalError`, which would crash the app at first launch whenever the
/// xcconfig pipeline didn't deliver a real URL to the plist.
public enum AppConfig {
    public static var apiBaseURL: URL {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "WorkCRMAPIBaseURL") as? String,
           !raw.isEmpty,
           !raw.hasPrefix("$"),                // not the unsubstituted "$(...)"
           let url = URL(string: raw) {
            return url
        }
        // Compile-time fallback by configuration.
        // Debug runs default at localhost so the Mac-hosted dev server works
        // for the simulator. To test against production from a physical
        // device, change the scheme to Release (Product → Scheme → Edit Scheme
        // → Run → Build Configuration → Release).
        #if DEBUG
        return URL(string: "http://localhost:3000/api/v1")!
        #else
        return URL(string: "https://app.thinkbizcrm.com/api/v1")!
        #endif
    }

    /// Default tenant slug shown pre-filled on LoginView. Kept here (not in a
    /// string table) because it's a build-time config more than a translation.
    public static let defaultTenantSlug = "workcrm"
}
