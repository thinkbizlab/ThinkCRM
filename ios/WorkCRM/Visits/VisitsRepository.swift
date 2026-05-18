import Foundation

/// Read- and write-side façade around the visit endpoints. Views talk to the
/// repository, not URLSession, so we can swap in offline cache reads / fake
/// fixtures without touching SwiftUI code.
public actor VisitsRepository {
    public static let shared = VisitsRepository()

    private init() {}

    // MARK: - Read

    /// Fetch the current rep's visits, paginated. When `dateFrom` and/or
    /// `dateTo` are supplied, the backend filters on Visit.plannedAt
    /// (gte / lte respectively).
    /// Backend: GET /api/v1/visits?status=&dateFrom=&dateTo=&limit=&offset=
    public func list(
        status: String? = nil,
        dateFrom: Date? = nil,
        dateTo: Date? = nil,
        limit: Int = 50,
        offset: Int = 0
    ) async throws -> Paginated<Visit> {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        var query: [URLQueryItem] = [
            URLQueryItem(name: "limit",  value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        if let status   { query.append(URLQueryItem(name: "status",   value: status)) }
        if let dateFrom { query.append(URLQueryItem(name: "dateFrom", value: iso.string(from: dateFrom))) }
        if let dateTo   { query.append(URLQueryItem(name: "dateTo",   value: iso.string(from: dateTo))) }
        return try await APIClient.shared.get("visits", query: query)
    }

    public func detail(_ id: String) async throws -> Visit {
        try await APIClient.shared.get("visits/\(id)")
    }

    // MARK: - Write

    /// Create a planned visit. Customer is required; objective is required.
    /// Backend: POST /api/v1/visits/planned
    public func createPlanned(_ req: PlannedVisitCreateRequest) async throws -> Visit {
        try await APIClient.shared.post("visits/planned", body: req)
    }

    /// Create an unplanned (drop-in) visit. Customer is optional — when
    /// omitted the backend auto-creates a Prospect from siteLat/siteLng so the
    /// visit has a target FK.
    /// Backend: POST /api/v1/visits/unplanned
    public func createUnplanned(_ req: UnplannedVisitCreateRequest) async throws -> Visit {
        try await APIClient.shared.post("visits/unplanned", body: req)
    }

    /// Edit a planned visit. Only PLANNED-status visits can be edited
    /// (backend rejects anything else with 400). Pass only the fields that
    /// changed; everything is optional.
    /// Backend: PATCH /api/v1/visits/:id
    public func update(id: String, _ req: VisitUpdateRequest) async throws -> Visit {
        try await APIClient.shared.patch("visits/\(id)", body: req)
    }
}

// MARK: - Request payloads

public struct PlannedVisitCreateRequest: Codable, Sendable {
    public let customerId: String
    public let plannedAt: String       // ISO 8601 (RFC 3339)
    public let objective: String
    public let dealId: String?
    public let siteLat: Double?
    public let siteLng: Double?

    public init(customerId: String, plannedAt: Date, objective: String, dealId: String? = nil, siteLat: Double? = nil, siteLng: Double? = nil) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        self.customerId = customerId
        self.plannedAt  = iso.string(from: plannedAt)
        self.objective  = objective
        self.dealId     = dealId
        self.siteLat    = siteLat
        self.siteLng    = siteLng
    }
}

public struct UnplannedVisitCreateRequest: Codable, Sendable {
    public let customerId: String?
    public let prospectId: String?
    public let plannedAt: String?
    public let objective: String?
    public let siteLat: Double?
    public let siteLng: Double?

    public init(customerId: String? = nil, prospectId: String? = nil, plannedAt: Date? = nil, objective: String? = nil, siteLat: Double? = nil, siteLng: Double? = nil) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        self.customerId = customerId
        self.prospectId = prospectId
        self.plannedAt  = plannedAt.map { iso.string(from: $0) }
        self.objective  = objective
        self.siteLat    = siteLat
        self.siteLng    = siteLng
    }
}

public struct VisitUpdateRequest: Codable, Sendable {
    public let customerId: String?
    public let plannedAt: String?
    public let objective: String?
    public let siteLat: Double?
    public let siteLng: Double?

    public init(customerId: String? = nil, plannedAt: Date? = nil, objective: String? = nil, siteLat: Double? = nil, siteLng: Double? = nil) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        self.customerId = customerId
        self.plannedAt  = plannedAt.map { iso.string(from: $0) }
        self.objective  = objective
        self.siteLat    = siteLat
        self.siteLng    = siteLng
    }
}
