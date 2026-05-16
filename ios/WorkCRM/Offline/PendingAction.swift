import Foundation

/// A queued state-changing request that the mobile app will retry until the
/// backend accepts it. Each row carries a stable `id` (uuid v4) that's also
/// the `clientRequestId` we send to the server — that's how the backend's
/// `ClientRequestLog` dedupe knows two retries are "the same request".
public struct PendingAction: Codable, Identifiable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case visitCheckIn  = "visit_checkin"
        case visitCheckOut = "visit_checkout"
    }

    public let id: String              // uuid v4 — also serves as clientRequestId
    public let kind: Kind
    public let visitId: String
    public let payload: Payload
    public let createdAt: Date

    /// Mutable: the sync engine updates these as it retries.
    public var retryCount: Int
    public var lastError: String?
    public var lastAttemptAt: Date?
    public var nextEligibleAt: Date    // exponential backoff target

    /// Discriminated payload — keeps the JSON shape symmetric with the
    /// server-side checkin/checkout schemas.
    public enum Payload: Codable, Sendable, Equatable {
        case checkIn(CheckInPayload)
        case checkOut(CheckOutPayload)

        // Custom Codable so we can serialise the discriminator inline; the
        // alternative (auto-synthesized enum coding) gives an awkward nested
        // shape that's hard to read in the JSON-on-disk file.
        private enum CodingKeys: String, CodingKey { case kind, data }
        private enum Discriminator: String, Codable { case checkIn, checkOut }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            switch try c.decode(Discriminator.self, forKey: .kind) {
            case .checkIn:  self = .checkIn(try c.decode(CheckInPayload.self,  forKey: .data))
            case .checkOut: self = .checkOut(try c.decode(CheckOutPayload.self, forKey: .data))
            }
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .checkIn(let p):  try c.encode(Discriminator.checkIn,  forKey: .kind); try c.encode(p, forKey: .data)
            case .checkOut(let p): try c.encode(Discriminator.checkOut, forKey: .kind); try c.encode(p, forKey: .data)
            }
        }
    }

    /// Mirrors `CheckInRequest` but stores a *path* to the selfie on disk
    /// instead of inlining base64 bytes — keeps the queue file tiny (the
    /// selfie itself lives in `Documents/offline-selfies/<id>.jpg`).
    public struct CheckInPayload: Codable, Sendable, Equatable {
        public var lat: Double
        public var lng: Double
        public var capturedAt: Date
        public var selfieFilename: String
    }

    public struct CheckOutPayload: Codable, Sendable, Equatable {
        public var lat: Double
        public var lng: Double
        public var capturedAt: Date
        public var result: String
    }
}

extension PendingAction {
    /// Convenience: build a fresh check-in row at capture time.
    public static func newCheckIn(visitId: String, lat: Double, lng: Double, capturedAt: Date, selfieFilename: String) -> PendingAction {
        PendingAction(
            id:              UUID().uuidString.lowercased(),
            kind:            .visitCheckIn,
            visitId:         visitId,
            payload:         .checkIn(.init(lat: lat, lng: lng, capturedAt: capturedAt, selfieFilename: selfieFilename)),
            createdAt:       Date(),
            retryCount:      0,
            lastError:       nil,
            lastAttemptAt:   nil,
            nextEligibleAt:  Date()      // ready immediately
        )
    }

    public static func newCheckOut(visitId: String, lat: Double, lng: Double, capturedAt: Date, result: String) -> PendingAction {
        PendingAction(
            id:              UUID().uuidString.lowercased(),
            kind:            .visitCheckOut,
            visitId:         visitId,
            payload:         .checkOut(.init(lat: lat, lng: lng, capturedAt: capturedAt, result: result)),
            createdAt:       Date(),
            retryCount:      0,
            lastError:       nil,
            lastAttemptAt:   nil,
            nextEligibleAt:  Date()
        )
    }
}
