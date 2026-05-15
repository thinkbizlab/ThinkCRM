import UIKit

/// Bridges the legacy AppDelegate callbacks (still required for APNs token
/// delivery) into our actor-based `APNsRegistrar`. Wired via
/// `@UIApplicationDelegateAdaptor` in `WorkCRMApp`.
public final class AppDelegate: NSObject, UIApplicationDelegate {
    public func application(_ application: UIApplication,
                            didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        return true
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
