import Foundation

/// Read-side façade around the visit endpoints. Views talk to the repository,
/// not URLSession, so we can swap in offline cache reads / fake fixtures
/// without touching SwiftUI code.
public actor VisitsRepository {
    public static let shared = VisitsRepository()

    private init() {}

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
}
