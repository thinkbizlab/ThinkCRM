import XCTest
@testable import WorkCRM

final class DashboardRepositoryTests: XCTestCase {
    func testDaysLeftInMonthMatchesBackendLogic() {
        // March 15 → 17 days left (15 + 16-31 inclusive)
        var comps = DateComponents()
        comps.year = 2026; comps.month = 3; comps.day = 15
        let cal = Calendar(identifier: .gregorian)
        let date = cal.date(from: comps)!
        XCTAssertEqual(DashboardRepository.daysLeftInMonth(now: date), 17)

        // Feb 28 → 1 (last day of feb 2026, non-leap)
        comps.month = 2; comps.day = 28
        XCTAssertEqual(DashboardRepository.daysLeftInMonth(now: cal.date(from: comps)!), 1)
    }

    func testCurrentMonthKeyShape() {
        let key = DashboardRepository.currentMonthKey()
        // Must be YYYY-MM so the backend's monthQuerySchema accepts it.
        XCTAssertTrue(key.matches(of: try Regex(#"^\d{4}-\d{2}$"#)).first != nil)
    }
}
