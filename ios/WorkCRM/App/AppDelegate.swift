import UIKit

/// Bridges the legacy AppDelegate callbacks (still required for APNs token
/// delivery) into our actor-based `APNsRegistrar`. Wired via
/// `@UIApplicationDelegateAdaptor` in `WorkCRMApp`.
public final class AppDelegate: NSObject, UIApplicationDelegate {
    public func application(_ application: UIApplication,
                            didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Must be registered before app finishes launching — the OS
        // calls our handler synchronously at wake time, so the handler must
        // already be installed.
        BackgroundSync.register()
        // Bootstraps Reachability so its NWPathMonitor starts publishing
        // before any view subscribes.
        _ = Reachability.shared
        // Try to drain any queue rows left over from a previous launch.
        Task { await SyncEngine.shared.drain() }
        return true
    }

    public func applicationDidEnterBackground(_ application: UIApplication) {
        BackgroundSync.schedule()
    }

    public func application(_ application: UIApplication,
                            didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await APNsRegistrar.shared.handleTokenRegistration(deviceToken) }
    }

    public func application(_ application: UIApplication,
                            didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[apns] failed to register: \(error)")
    }
}
