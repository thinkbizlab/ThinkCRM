import SwiftUI

/// TODO: render KPI rings + a "X working days left" banner using
/// `GET /api/v1/dashboard/overview?month=YYYY-MM&repId=<me>`. Pair with
/// `GET /api/v1/kpi-targets` to render target vs. actual.
struct PersonalKpiView: View {
    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()
            VStack(spacing: Theme.Spacing.lg) {
                Eyebrow(t(.kpiPersonalTitle))
                Text("Personal KPI charts — coming soon")
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
            }
        }
    }
}

struct TeamKpiView: View {
    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()
            VStack(spacing: Theme.Spacing.lg) {
                Eyebrow(t(.kpiTeamTitle))
                Text("Team KPI breakdown — coming soon")
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
            }
        }
        .navigationTitle(t(.kpiTeamTitle))
    }
}
