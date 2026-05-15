import Foundation

// Codable structs mirroring the Fastify API response shapes. Only fields the
// iOS client actually reads are included — the server is free to add more.

// MARK: - Auth

public struct LoginRequest: Codable, Sendable {
    public let tenantSlug: String
    public let email: String
    public let password: String
}

public struct LoginResponse: Codable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let tokenType: String
    public let user: User
}

public struct RefreshRequest: Codable, Sendable {
    public let refreshToken: String
}

public struct RefreshResponse: Codable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let tokenType: String
}

public struct DeviceRegistrationRequest: Codable, Sendable {
    public let platform: String     // "IOS" | "ANDROID"
    public let deviceToken: String
    public let deviceName: String?
}

// MARK: - User

public struct User: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let tenantId: String
    public let tenantSlug: String
    public let role: String
    public let email: String
    public let fullName: String
    public let avatarUrl: String?
}

// MARK: - Pagination wrapper

/// Backend's opt-in pagination shape: `{ rows, total, limit, offset }`.
public struct Paginated<T: Codable & Sendable>: Codable, Sendable {
    public let rows: [T]
    public let total: Int
    public let limit: Int
    public let offset: Int
}

// MARK: - Visit

public struct Visit: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let tenantId: String
    public let visitNo: String?
    public let status: String       // PLANNED | CHECKED_IN | CHECKED_OUT | …
    public let plannedAt: Date?
    public let checkInAt: Date?
    public let checkOutAt: Date?
    public let objective: String?
    public let result: String?
    public let siteLat: Double?
    public let siteLng: Double?
    public let customer: VisitCustomerRef?
    public let deal: VisitDealRef?
}

public struct VisitCustomerRef: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
}

public struct VisitDealRef: Codable, Sendable, Equatable {
    public let id: String
    public let dealNo: String?
    public let dealName: String?
}

public struct CheckInRequest: Codable, Sendable {
    public let lat: Double
    public let lng: Double
    public let selfieUrl: String            // data:image/jpeg;base64,…
    public let capturedAt: String?
    /// uuid v4 from the offline-sync queue — server uses this for dedupe.
    public let clientRequestId: String?
}

public struct CheckOutRequest: Codable, Sendable {
    public let lat: Double
    public let lng: Double
    public let result: String
    public let capturedAt: String?
    public let clientRequestId: String?
}

// MARK: - Deal

public struct Deal: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let dealNo: String?
    public let dealName: String
    public let stageId: String
    public let status: String           // OPEN | WON | LOST
    public let estimatedAmount: Double?
    public let closedDate: Date?
    public let nextContactDate: Date?
    public let progress: Int?
    public let customerId: String?
}

// MARK: - Master data

public struct Customer: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let customerCode: String?
    public let name: String
    public let taxId: String?
    public let disabled: Bool?
}

public struct Item: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let itemCode: String
    public let name: String
    public let unitPrice: Double
    public let isActive: Bool
}

public struct PaymentTerm: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let code: String
    public let name: String
    public let dueDays: Int
}
