import Foundation

public actor DashboardRepository {
    public static let shared = DashboardRepository()
    private init() {}

    public func overview(month: String? = nil, repId: String? = nil, teamId: String? = nil) async throws -> DashboardOverview {
        var query: [URLQueryItem] = []
        if let month  { query.append(URLQueryItem(name: "month",  value: month)) }
        if let repId  { query.append(URLQueryItem(name: "repId",  value: repId)) }
        if let teamId { query.append(URLQueryItem(name: "teamId", value: teamId)) }
        return try await APIClient.shared.get("dashboard/overview", query: query)
    }

    /// "5 working days left" header — same logic the backend's KPI-alert cron
    /// uses (`isLastFiveDaysOfMonth`). Computed client-side so the personal
    /// dashboard doesn't need to round-trip just to render a banner.
    public static func daysLeftInMonth(now: Date = Date()) -> Int {
        let cal = Calendar(identifier: .gregorian)
        guard let range = cal.range(of: .day, in: .month, for: now) else { return 0 }
        let lastDay = range.upperBound - 1
        let today = cal.component(.day, from: now)
        return max(0, lastDay - today + 1)
    }

    public static func currentMonthKey() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM"
        return f.string(from: Date())
    }
}
