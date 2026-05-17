import AVFoundation
import CoreLocation
import Foundation
import SwiftUI
import UIKit
import UserNotifications

/// One place to read and request every system permission WorkCRM uses:
///   - **Location** (visit check-in / check-out GPS)
///   - **Camera** (check-in selfie)
///   - **Microphone** (check-out voice notes)
///   - **Push notifications** (KPI alerts, weekly digest, future per-visit pings)
///
/// `@Published` statuses let the OnboardingView and any guarded action drive
/// their UI off the same source of truth. After the user returns from the
/// Settings app, call `refresh()` to re-read the system state.
@MainActor
public final class PermissionsManager: NSObject, ObservableObject {
    public static let shared = PermissionsManager()

    @Published public private(set) var locationStatus:    CLAuthorizationStatus
    @Published public private(set) var cameraStatus:      AVAuthorizationStatus
    @Published public private(set) var microphoneStatus:  AVAuthorizationStatus
    @Published public private(set) var notificationStatus: UNAuthorizationStatus

    private let locationManager = CLLocationManager()
    private var locationContinuation: CheckedContinuation<Void, Never>?

    private override init() {
        // CLLocationManager() can only be initialised on the main thread; the
        // initial status read is cheap, and the published values are kept in
        // sync via the delegate after that.
        let cl = CLLocationManager()
        self.locationStatus     = cl.authorizationStatus
        self.cameraStatus       = AVCaptureDevice.authorizationStatus(for: .video)
        self.microphoneStatus   = AVCaptureDevice.authorizationStatus(for: .audio)
        self.notificationStatus = .notDetermined
        super.init()
        locationManager.delegate = self
        Task { await refreshNotificationStatus() }
    }

    // MARK: - Public API

    public func refresh() {
        locationStatus    = locationManager.authorizationStatus
        cameraStatus      = AVCaptureDevice.authorizationStatus(for: .video)
        microphoneStatus  = AVCaptureDevice.authorizationStatus(for: .audio)
        Task { await refreshNotificationStatus() }
    }

    /// True if any required permission is still `.notDetermined` — the user
    /// hasn't been asked yet. Drives whether OnboardingView shows on sign-in.
    public var needsOnboarding: Bool {
        locationStatus    == .notDetermined ||
        cameraStatus      == .notDetermined ||
        microphoneStatus  == .notDetermined ||
        notificationStatus == .notDetermined
    }

    /// True if any permission was explicitly denied. Drives the per-action
    /// "Open Settings" sheets — we can't re-prompt programmatically after a
    /// denial, only direct the user to iOS Settings.
    public func isDenied(_ kind: PermissionKind) -> Bool {
        switch kind {
        case .location:     return locationStatus    == .denied || locationStatus    == .restricted
        case .camera:       return cameraStatus      == .denied || cameraStatus      == .restricted
        case .microphone:   return microphoneStatus  == .denied || microphoneStatus  == .restricted
        case .notifications:return notificationStatus == .denied
        }
    }

    public func isGranted(_ kind: PermissionKind) -> Bool {
        switch kind {
        case .location:
            return locationStatus == .authorizedWhenInUse || locationStatus == .authorizedAlways
        case .camera:        return cameraStatus       == .authorized
        case .microphone:    return microphoneStatus   == .authorized
        case .notifications: return notificationStatus == .authorized || notificationStatus == .provisional
        }
    }

    // MARK: - Request flows

    /// Show the system Location prompt and await the user's choice. Returns
    /// the granted state after the prompt resolves.
    @discardableResult
    public func requestLocation() async -> Bool {
        if locationStatus != .notDetermined { return isGranted(.location) }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            self.locationContinuation = cont
            self.locationManager.requestWhenInUseAuthorization()
        }
        return isGranted(.location)
    }

    @discardableResult
    public func requestCamera() async -> Bool {
        if cameraStatus != .notDetermined { return isGranted(.camera) }
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        self.cameraStatus = AVCaptureDevice.authorizationStatus(for: .video)
        return granted
    }

    @discardableResult
    public func requestMicrophone() async -> Bool {
        if microphoneStatus != .notDetermined { return isGranted(.microphone) }
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        self.microphoneStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        return granted
    }

    @discardableResult
    public func requestNotifications() async -> Bool {
        if notificationStatus != .notDetermined { return isGranted(.notifications) }
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .badge, .sound])
            await refreshNotificationStatus()
            return granted
        } catch {
            return false
        }
    }

    /// Hand the user off to the WorkCRM page in iOS Settings. Returns `false`
    /// if the URL couldn't open — extremely rare.
    @discardableResult
    public func openAppSettings() async -> Bool {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return false }
        return await UIApplication.shared.open(url)
    }

    // MARK: - Private

    private func refreshNotificationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        self.notificationStatus = settings.authorizationStatus
    }
}

public enum PermissionKind: String, CaseIterable, Sendable, Identifiable, Hashable {
    case location
    case camera
    case microphone
    case notifications

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .location:      return "Location"
        case .camera:        return "Camera"
        case .microphone:    return "Microphone"
        case .notifications: return "Notifications"
        }
    }

    public var systemImage: String {
        switch self {
        case .location:      return "location.fill"
        case .camera:        return "camera.fill"
        case .microphone:    return "mic.fill"
        case .notifications: return "bell.fill"
        }
    }

    public var rationale: String {
        switch self {
        case .location:
            return "Records your GPS location at check-in and check-out so your manager can verify on-site visits. Used only during the check-in/out flow."
        case .camera:
            return "Captures a check-in selfie when you arrive at a customer site. The photo is attached to the visit record and visible to your manager."
        case .microphone:
            return "Records voice notes during check-out so you can summarise the visit without typing. Audio is transcribed server-side."
        case .notifications:
            return "Sends KPI alerts, weekly summaries, and visit reminders. Tapping a notification opens the relevant screen."
        }
    }
}

extension PermissionsManager: CLLocationManagerDelegate {
    nonisolated public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.locationStatus = status
            if status != .notDetermined {
                self.locationContinuation?.resume()
                self.locationContinuation = nil
            }
        }
    }
}
