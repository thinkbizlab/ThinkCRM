import Foundation

public actor DealsRepository {
    public static let shared = DealsRepository()
    private init() {}

    public func listStages() async throws -> [DealStage] {
        try await APIClient.shared.get("deals/stages")
    }

    public func listDeals(limit: Int = 200, offset: Int = 0, customerId: String? = nil) async throws -> Paginated<Deal> {
        var query: [URLQueryItem] = [
            URLQueryItem(name: "limit",  value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        if let customerId { query.append(URLQueryItem(name: "customerId", value: customerId)) }
        return try await APIClient.shared.get("deals", query: query)
    }

    public func detail(_ id: String) async throws -> Deal {
        try await APIClient.shared.get("deals/\(id)")
    }

    public func update(_ id: String, with patch: DealUpdateRequest) async throws -> Deal {
        try await APIClient.shared.patch("deals/\(id)", body: patch)
    }

    public func progressUpdates(for dealId: String) async throws -> [DealProgressUpdate] {
        try await APIClient.shared.get("deals/\(dealId)/progress-updates")
    }

    public func postProgress(for dealId: String, note: String) async throws -> DealProgressUpdate {
        try await APIClient.shared.post("deals/\(dealId)/progress-updates", body: DealProgressUpdateRequest(note: note))
    }
}
