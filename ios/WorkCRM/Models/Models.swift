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
    public let dealNo: String
    public let dealName: String
    public let stageId: String
    public let status: String              // OPEN | WON | LOST
    public let estimatedValue: Double
    public let followUpAt: Date
    public let closedAt: Date?
    public let customerId: String
    public let ownerId: String?
    public let lostNote: String?
}

public struct DealStage: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let stageName: String
    public let stageOrder: Int
    public let isClosedWon: Bool
    public let isClosedLost: Bool
    public let isDefault: Bool?
}

public struct DealUpdateRequest: Codable, Sendable {
    public let estimatedValue: Double?
    public let followUpAt: String?         // ISO-8601
    public let closedAt: String?           // ISO-8601 or empty to clear
    public let stageId: String?
}

public struct DealProgressUpdateRequest: Codable, Sendable {
    public let note: String
}

// MARK: - Dashboard / KPI

public struct DashboardOverview: Codable, Sendable {
    public let period: Period
    public let kpis: KpiSummary
    public let targetVsActual: [TargetVsActual]
    public let teamPerformance: [TeamPerformanceRow]?

    public struct Period: Codable, Sendable {
        public let month: String
        public let dateFrom: Date
        public let dateTo: Date
    }
}

public struct KpiSummary: Codable, Sendable {
    public let activeDeals: Int
    public let pipelineValue: Double
    public let wonValue: Double
    public let lostValue: Double
    public let visitCompletionRate: Double
    public let dealsCreatedInPeriod: Int
    public let visitsPlannedInPeriod: Int
    public let usersInScope: Int
}

public struct TargetVsActual: Codable, Sendable, Identifiable {
    public let userId: String
    public let userName: String
    public let avatarUrl: String?
    public let teamId: String?
    public let teamName: String
    public let month: String
    public let target: Triple
    public let actual: Triple
    public let progress: Triple
    public var id: String { userId }

    public struct Triple: Codable, Sendable {
        public let visits: Double
        public let newDealValue: Double
        public let revenue: Double
    }
}

public struct TeamPerformanceRow: Codable, Sendable, Identifiable {
    public let teamId: String
    public let teamName: String
    public let memberCount: Int
    public let activeDeals: Int
    public let pipelineValue: Double
    public let wonValue: Double
    public let lostValue: Double
    public let checkedOutVisits: Int
    public let plannedVisits: Int
    public let visitCompletionRate: Double
    public var id: String { teamId }
}

public struct DealProgressUpdate: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let dealId: String
    public let note: String
    public let createdAt: Date
    public let createdBy: ProgressAuthor?

    public struct ProgressAuthor: Codable, Sendable, Equatable {
        public let id: String
        public let fullName: String?
    }
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
