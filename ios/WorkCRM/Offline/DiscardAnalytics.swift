import Foundation

/// Sends a batch of "user discarded a permanently-failed offline action"
/// events to the backend so admins can spot patterns. Best-effort: a failed
/// POST here doesn't block the discard itself (the user wants the row gone
/// regardless of whether analytics reached the server).
public struct SyncDiscardEvent: Codable, Sendable {
    public let kind: String              // "visit_checkin" | "visit_checkout"
    public let visitId: String
    public let retryCount: Int
    public let lastError: String?        // truncated to 500 chars before send
    public let queuedDurationMs: Int
    public let platform: String          // "IOS"
}

public struct SyncDiscardBatch: Codable, Sendable {
    public let events: [SyncDiscardEvent]
}

public enum DiscardAnalytics {
    /// Build the event payload from a queued action being discarded.
    /// Truncates `lastError` to 500 chars defensively — backend caps at 500
    /// too, but we'd rather lose the suffix than the whole event.
    public static func event(for action: PendingAction, now: Date = Date()) -> SyncDiscardEvent {
        let kind: String = (action.kind == .visitCheckIn) ? "visit_checkin" : "visit_checkout"
        let trimmedError: String? = action.lastError.map { String($0.prefix(500)) }
        let queuedMs = Int(now.timeIntervalSince(action.createdAt) * 1000)
        return SyncDiscardEvent(
            kind:             kind,
            visitId:          action.visitId,
            retryCount:       action.retryCount,
            lastError:        trimmedError,
            queuedDurationMs: max(0, queuedMs),
            platform:         "IOS"
        )
    }

    /// Fire-and-forget post. Errors are swallowed — the caller has already
    /// committed to discarding the row, and the analytics row is opportunistic.
    public static func report(_ events: [SyncDiscardEvent]) async {
        guard !events.isEmpty else { return }
        let batch = SyncDiscardBatch(events: events)
        do {
            try await APIClient.shared.postExpectingEmpty("sync/discards", body: batch)
        } catch {
            // Non-fatal — the user-visible action (Discard) already completed.
            print("[discard-analytics] post failed: \(error)")
        }
    }
}
