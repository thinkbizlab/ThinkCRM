import Foundation

/// Read-side façade around the visit endpoints. Views talk to the repository,
/// not URLSession, so we can swap in offline cache reads / fake fixtures
/// without touching SwiftUI code.
public actor VisitsRepository {
    public static let shared = VisitsRepository()

    private init() {}

    /// Fetch the current rep's planned + checked-in visits, paginated.
    /// Backend: GET /api/v1/visits?status=&limit=&offset=
    public func list(status: String? = nil, limit: Int = 50, offset: Int = 0) async throws -> Paginated<Visit> {
        var query: [URLQueryItem] = [
            URLQueryItem(name: "limit",  value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        if let status { query.append(URLQueryItem(name: "status", value: status)) }
        return try await APIClient.shared.get("visits", query: query)
    }

    public func detail(_ id: String) async throws -> Visit {
        try await APIClient.shared.get("visits/\(id)")
    }
}
