import Foundation
import CoreLocation

/// Single-fix wrapper around `CLLocationManager`. Used at check-in / check-out
/// to capture coordinates exactly once at the moment the user confirms the
/// action — same pattern the web client uses with `navigator.geolocation`.
///
/// The first time it's called we may need to ask the user for permission. The
/// system prompt is asynchronous: we *cannot* call `requestLocation()` until
/// the user has actually answered, otherwise CoreLocation immediately replies
/// `kCLErrorDenied` (the user is still deciding, so authorization is "not yet
/// granted" from CL's perspective). So this class awaits the
/// `locationManagerDidChangeAuthorization` delegate callback before kicking
/// off the location request.
@MainActor
public final class LocationService: NSObject, @unchecked Sendable {
    public static let shared = LocationService()

    private let manager: CLLocationManager
    private var locationContinuation: CheckedContinuation<CLLocation, Error>?
    private var authContinuation: CheckedContinuation<Void, Error>?

    private override init() {
        self.manager = CLLocationManager()
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    public enum LocationError: Error, LocalizedError {
        case authorizationDenied
        case underlying(Error)

        public var errorDescription: String? {
            switch self {
            case .authorizationDenied:
                return "Location permission was denied. Open Settings → WorkCRM → Location and choose 'While Using the App' to check in."
            case .underlying(let err):
                // CLError code 1 ('Denied') has the same root cause as
                // .authorizationDenied; surface the actionable message.
                if let clErr = err as? CLError, clErr.code == .denied {
                    return "Location permission was denied. Open Settings → WorkCRM → Location and choose 'While Using the App' to check in."
                }
                return err.localizedDescription
            }
        }
    }

    public func currentLocation() async throws -> CLLocation {
        // Step 1 — resolve permission. The locationManagerDidChangeAuthorization
        // delegate may fire several times during the prompt sequence (typically
        // notDetermined → notDetermined → authorizedWhenInUse). We only resume
        // the continuation when we reach a terminal state.
        switch manager.authorizationStatus {
        case .denied, .restricted:
            throw LocationError.authorizationDenied
        case .notDetermined:
            try await requestAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            break
        @unknown default:
            throw LocationError.authorizationDenied
        }

        // Step 2 — now that permission is granted, request a single fix.
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<CLLocation, Error>) in
            self.locationContinuation = cont
            self.manager.requestLocation()
        }
    }

    private func requestAuthorization() async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            self.authContinuation = cont
            self.manager.requestWhenInUseAuthorization()
        }
    }
}

extension LocationService: CLLocationManagerDelegate {
    nonisolated public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in
            self.locationContinuation?.resume(returning: location)
            self.locationContinuation = nil
        }
    }

    nonisolated public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.locationContinuation?.resume(throwing: LocationError.underlying(error))
            self.locationContinuation = nil
        }
    }

    nonisolated public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            switch status {
            case .authorizedWhenInUse, .authorizedAlways:
                self.authContinuation?.resume(returning: ())
                self.authContinuation = nil
            case .denied, .restricted:
                self.authContinuation?.resume(throwing: LocationError.authorizationDenied)
                self.authContinuation = nil
            case .notDetermined:
                // The system fires this once when the manager is created with
                // status .notDetermined — before the user has answered the
                // prompt. Wait for the next update.
                break
            @unknown default:
                self.authContinuation?.resume(throwing: LocationError.authorizationDenied)
                self.authContinuation = nil
            }
        }
    }
}
