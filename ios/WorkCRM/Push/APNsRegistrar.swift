import Foundation
import UIKit
import UserNotifications

/// Owns APNs lifecycle: requests authorization, registers for remote
/// notifications, and POSTs the resulting device token to
/// `/api/v1/auth/devices` so the backend's `sendPushToUser()` can fan out to
/// this device. Idempotent — safe to call on every cold launch.
public actor APNsRegistrar {
    public static let shared = APNsRegistrar()

    private init() {}

    /// Ask the OS for permission and, if granted, register. Called after a
    /// successful sign-in (the user has just shown intent to use the app — a
    /// permission prompt at that moment is much more likely to get a yes than
    /// at first cold launch).
    public func registerIfAuthorized() async {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        guard granted else { return }
        await MainActor.run {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Called by the AppDelegate when the OS hands us a fresh token.
    public func handleTokenRegistration(_ deviceToken: Data) async {
        let tokenHex = deviceToken.map { String(format: "%02x", $0) }.joined()
        do {
            let request = DeviceRegistrationRequest(
                platform:    "IOS",
                deviceToken: tokenHex,
                deviceName:  await UIDevice.current.name
            )
            try await APIClient.shared.postExpectingEmpty("auth/devices", body: request)
        } catch {
            // Non-fatal — the next sign-in will retry. Log so we can spot
            // regressions in development.
            print("[apns] device registration failed: \(error)")
        }
    }
}
