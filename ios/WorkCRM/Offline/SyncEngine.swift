import Foundation

/// Drains `PendingActionStore` against the backend. Single-flight: only one
/// `drain()` runs at a time; calls that arrive while a drain is in flight
/// just return immediately (the in-flight drain will pick up newly enqueued
/// rows before exiting).
///
/// Exponential backoff for transient failures (network, 5xx): 30s, 2m, 10m,
/// 30m, 1h, capped at 1h. Permanent failures (4xx that aren't 401/429) leave
/// the row in the queue but with `lastError` set — the user can review and
/// discard in the Sync Status screen (future work).
public actor SyncEngine {
    public static let shared = SyncEngine()

    private var draining: Bool = false

    private init() {}

    /// Reset a row so it's eligible immediately and clear its backoff/error
    /// state. Used by the "Retry now" button on the Sync Status screen — we
    /// don't just call drain() because a permanently-failed row has
    /// nextEligibleAt 24h in the future from the failure path.
    public func retryNow(actionId: String) async {
        await MainActor.run {
            guard let action = PendingActionStore.shared.actions.first(where: { $0.id == actionId }) else { return }
            var reset = action
            reset.retryCount = 0
            reset.lastError = nil
            reset.nextEligibleAt = Date()
            PendingActionStore.shared.update(reset)
        }
        await drain()
    }

    /// Process eligible rows in `createdAt ASC` order, one at a time. The
    /// per-row failure paths classify the response and either remove the row
    /// (success), reschedule it (transient), or mark it failed (permanent).
    public func drain() async {
        if draining { return }
        draining = true
        defer { draining = false }

        // We need the actions list from the main-actor store; hop there for
        // the read, then do the HTTP work back on this actor.
        while let action = await MainActor.run(body: { PendingActionStore.shared.nextEligible() }) {
            await process(action)
            // Yield so a flood of queued actions doesn't starve the run loop.
            await Task.yield()
        }
    }

    private func process(_ action: PendingAction) async {
        do {
            switch action.payload {
            case .checkIn(let p):
                try await sendCheckIn(action: action, payload: p)
            case .checkOut(let p):
                try await sendCheckOut(action: action, payload: p)
            }
            // Success — drop the queue row + clean up the on-disk selfie.
            await MainActor.run {
                PendingActionStore.shared.remove(id: action.id)
            }
            if case .checkIn(let p) = action.payload {
                SelfieStore.shared.delete(filename: p.selfieFilename)
            }
        } catch let APIError.http(status, body) where (400..<500).contains(status) && status != 401 && status != 408 && status != 429 {
            // Permanent client error — leave the row but flag it so the user
            // can act on it. Push nextEligibleAt far into the future so we
            // don't burn cycles re-trying, and bump retryCount past the Sync
            // Status "show Discard" threshold (>= 3) so the user has an
            // immediate way to clear the stuck row.
            var failed = action
            failed.retryCount = max(failed.retryCount + 1, 3)
            failed.lastError = friendlyPermanentError(status: status, body: body)
            failed.lastAttemptAt = Date()
            failed.nextEligibleAt = Date().addingTimeInterval(24 * 60 * 60)
            await MainActor.run { PendingActionStore.shared.update(failed) }
        } catch {
            // Transient — exponential backoff.
            var retry = action
            retry.retryCount += 1
            retry.lastError = error.localizedDescription
            retry.lastAttemptAt = Date()
            retry.nextEligibleAt = Date().addingTimeInterval(Self.backoffSeconds(retry.retryCount))
            await MainActor.run { PendingActionStore.shared.update(retry) }
        }
    }

    private func sendCheckIn(action: PendingAction, payload: PendingAction.CheckInPayload) async throws {
        let jpegData: Data
        do {
            jpegData = try SelfieStore.shared.load(filename: payload.selfieFilename)
        } catch {
            // The selfie was lost (user manually deleted Documents?). Don't
            // hold the queue forever for an irrecoverable input.
            throw APIError.http(status: 410, body: "selfie file missing")
        }

        let request = CheckInRequest(
            lat:             payload.lat,
            lng:             payload.lng,
            selfieUrl:       SelfieStore.dataUri(forJpeg: jpegData),
            capturedAt:      ISO8601DateFormatter.iso8601String(from: payload.capturedAt),
            clientRequestId: action.id
        )
        let _: VisitCheckInResponse = try await APIClient.shared.post("visits/\(action.visitId)/checkin", body: request)
    }

    private func sendCheckOut(action: PendingAction, payload: PendingAction.CheckOutPayload) async throws {
        let request = CheckOutRequest(
            lat:             payload.lat,
            lng:             payload.lng,
            result:          payload.result,
            capturedAt:      ISO8601DateFormatter.iso8601String(from: payload.capturedAt),
            clientRequestId: action.id
        )
        let _: VisitCheckOutResponse = try await APIClient.shared.post("visits/\(action.visitId)/checkout", body: request)
    }

    /// Map HTTP status codes to messages that tell the user what to do, not
    /// what went wrong technically. The raw `HTTP 413: …` is useful for me in
    /// Sentry but unhelpful sitting in a rep's Sync Status screen.
    private func friendlyPermanentError(status: Int, body: String?) -> String {
        switch status {
        case 413:
            return "Selfie too large to upload. Discard this row and re-take the check-in."
        case 410:
            return "Selfie file missing on device. Discard this row and re-take the check-in."
        case 404:
            return "Visit not found — it may have been deleted or reassigned. Discard this row."
        case 403:
            return "You don't have permission to check in to this visit. Discard this row."
        case 400:
            return "Request rejected by the server. \(body ?? "")".trimmingCharacters(in: .whitespaces)
        default:
            return "HTTP \(status): \(body ?? "")".trimmingCharacters(in: .whitespaces)
        }
    }

    /// 30s, 2m, 10m, 30m, 1h, capped at 1h.
    private static func backoffSeconds(_ retryCount: Int) -> TimeInterval {
        let table: [TimeInterval] = [30, 120, 600, 1800, 3600]
        let idx = min(max(retryCount - 1, 0), table.count - 1)
        return table[idx]
    }
}

/// Backend's response shape — we only need the `visit` for now but full
/// shape is here for future use.
public struct VisitCheckInResponse: Codable, Sendable {
    public let visit: Visit
    public let notifWarnings: [String]?
}

public struct VisitCheckOutResponse: Codable, Sendable {
    public let visit: Visit
    public let notifWarnings: [String]?
}

extension ISO8601DateFormatter {
    /// Stable per-thread formatter producing the shape the backend expects.
    static func iso8601String(from date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }
}
