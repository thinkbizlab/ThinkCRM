import Foundation
import Network

/// Thin wrapper around `NWPathMonitor`. Publishes `isOnline` on the main actor
/// so SwiftUI views can drive an offline indicator and the `SyncEngine` can
/// drain whenever connectivity returns.
@MainActor
public final class Reachability: ObservableObject {
    public static let shared = Reachability()

    @Published public private(set) var isOnline: Bool = true

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.workstationoffice.workcrm.reachability")

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                let wasOffline = !self.isOnline
                self.isOnline = online
                if online && wasOffline {
                    // Connectivity restored — wake the drain loop. Fire and
                    // forget; the engine handles its own re-entrancy.
                    Task { await SyncEngine.shared.drain() }
                }
            }
        }
        monitor.start(queue: queue)
    }
}
