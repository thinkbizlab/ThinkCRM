import Foundation
import Combine

/// Durable on-disk queue of `PendingAction` rows. JSON file written
/// atomically — for the MVP queue cap of 50 actions this is plenty fast and
/// avoids dragging in GRDB. Swap to SQLite if the queue ever needs to scale.
///
/// The store publishes its `actions` array on `objectWillChange` so SwiftUI
/// views (the pending-sync chip on a visit row, the global footer) can react
/// without polling.
@MainActor
public final class PendingActionStore: ObservableObject {
    public static let shared = PendingActionStore()

    @Published public private(set) var actions: [PendingAction] = []

    private let fileURL: URL
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        self.fileURL = docs.appendingPathComponent("pending-actions.json", isDirectory: false)
        self.actions = readFromDisk()
    }

    public var pendingCount: Int { actions.count }

    public func actionsForVisit(_ visitId: String) -> [PendingAction] {
        actions.filter { $0.visitId == visitId }
    }

    /// Append a new row. Persists to disk before returning so a crash mid-call
    /// can't lose the user's check-in.
    public func enqueue(_ action: PendingAction) {
        actions.append(action)
        writeToDisk()
    }

    /// Remove a row by id (drain success path).
    public func remove(id: String) {
        actions.removeAll { $0.id == id }
        writeToDisk()
    }

    /// Replace a row in place (drain retry path: bump retryCount, set lastError, schedule next eligibility).
    public func update(_ action: PendingAction) {
        guard let idx = actions.firstIndex(where: { $0.id == action.id }) else { return }
        actions[idx] = action
        writeToDisk()
    }

    /// Next action eligible to attempt right now, or nil if none are ready.
    public func nextEligible(now: Date = Date()) -> PendingAction? {
        actions
            .filter { $0.nextEligibleAt <= now }
            .sorted { $0.createdAt < $1.createdAt }
            .first
    }

    // MARK: - Disk I/O

    private func readFromDisk() -> [PendingAction] {
        guard
            FileManager.default.fileExists(atPath: fileURL.path),
            let data = try? Data(contentsOf: fileURL),
            let decoded = try? decoder.decode([PendingAction].self, from: data)
        else { return [] }
        return decoded
    }

    private func writeToDisk() {
        do {
            let data = try encoder.encode(actions)
            try data.write(to: fileURL, options: [.atomic])
        } catch {
            // Disk failure here is rare and there's nothing useful we can do
            // beyond logging — the in-memory state will diverge until the next
            // process launch reloads from disk, which is acceptable.
            print("[offline] failed to persist pending actions: \(error)")
        }
    }
}
