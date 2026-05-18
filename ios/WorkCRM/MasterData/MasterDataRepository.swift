import Foundation

/// Read-only thin wrapper around the master-data endpoints. The web client
/// owns create/edit; the mobile MVP is browse-only so a rep can look up a
/// customer or item while on the road.
public actor MasterDataRepository {
    public static let shared = MasterDataRepository()
    private init() {}

    /// Backend: `GET /api/v1/customers?page=&pageSize=`. Returns the
    /// `{ rows, total, page, pageSize, totalPages }` shape when `page` is
    /// present (which we always pass for the mobile list).
    public func customers(page: Int, pageSize: Int = 50, scope: String = "mine") async throws -> CustomerPage {
        let query: [URLQueryItem] = [
            URLQueryItem(name: "page",     value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize)),
            URLQueryItem(name: "scope",    value: scope)
        ]
        return try await APIClient.shared.get("customers", query: query)
    }

    /// Backend: `GET /api/v1/items?limit=&offset=` (opt-in pagination shipped
    /// with Phase 1 backend prep).
    public func items(limit: Int = 50, offset: Int = 0) async throws -> Paginated<Item> {
        let query: [URLQueryItem] = [
            URLQueryItem(name: "limit",  value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        return try await APIClient.shared.get("items", query: query)
    }

    /// Type-ahead customer search. Backend enforces a 3-char minimum on `q`
    /// to keep ILIKE costs bounded; callers should gate the request the same
    /// way before hitting this. Scope mirrors the web client:
    ///   - "mine" (default) → customers I own
    ///   - "team"           → customers visible via team hierarchy
    ///   - "all"            → tenant-wide (admin)
    /// Backend: `GET /api/v1/customers/search?q=&limit=&scope=`
    public func searchCustomers(q: String, limit: Int = 20, scope: String = "team") async throws -> [Customer] {
        let query: [URLQueryItem] = [
            URLQueryItem(name: "q",     value: q),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "scope", value: scope)
        ]
        return try await APIClient.shared.get("customers/search", query: query)
    }
}

/// Backend's customer-list pagination response shape — distinct from the
/// `{rows,total,limit,offset}` envelope used by visits/deals/items.
public struct CustomerPage: Codable, Sendable {
    public let rows: [Customer]
    public let total: Int
    public let page: Int
    public let pageSize: Int
    public let totalPages: Int
}
