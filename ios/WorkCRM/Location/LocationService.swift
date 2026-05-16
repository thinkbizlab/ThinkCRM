import Foundation
import CoreLocation

/// Single-fix wrapper around `CLLocationManager`. Used at check-in / check-out
/// to capture coordinates exactly once at the moment the user confirms the
/// action — same pattern the web client uses with `navigator.geolocation`.
public final class LocationService: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
    public static let shared = LocationService()

    private let manager: CLLocationManager
    private var continuation: CheckedContinuation<CLLocation, Error>?

    public override init() {
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
            case .authorizationDenied:    return "Location permission was denied. Enable it in Settings → WorkCRM."
            case .underlying(let err):    return err.localizedDescription
            }
        }
    }

    /// Request a single fix. Implicitly asks for When-In-Use authorization if
    /// the app hasn't already been granted. Throws if the user denies.
    public func currentLocation() async throws -> CLLocation {
        switch manager.authorizationStatus {
        case .denied, .restricted:
            throw LocationError.authorizationDenied
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
            // We can't truly await the auth callback in pure Swift here
            // without more wiring; we fall through and let `requestLocation`
            // either succeed (auth granted in the prompt) or fail with denied.
        default:
            break
        }

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<CLLocation, Error>) in
            self.continuation = cont
            manager.requestLocation()
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let location = locations.last {
            continuation?.resume(returning: location)
            continuation = nil
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        continuation?.resume(throwing: LocationError.underlying(error))
        continuation = nil
    }
}
