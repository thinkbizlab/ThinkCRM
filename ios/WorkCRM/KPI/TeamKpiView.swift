import SwiftUI

struct TeamKpiView: View {
    @StateObject private var model = TeamKpiViewModel()

    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    Eyebrow(t(.kpiTeamTitle))
                    if model.isLoading && model.teamRows.isEmpty {
                        ProgressView().tint(Theme.Color.accent)
                            .frame(maxWidth: .infinity, minHeight: 200)
                    } else if model.teamRows.isEmpty {
                        Text("No team data yet")
                            .font(Theme.Font.body())
                            .foregroundStyle(Theme.Color.textSecondary)
                    } else {
                        ForEach(model.teamRows) { row in
                            teamRow(row)
                        }
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .refreshable { await model.refresh() }
        }
        .navigationTitle(t(.kpiTeamTitle))
        .task { await model.refresh() }
    }

    @ViewBuilder
    private func teamRow(_ row: TeamPerformanceRow) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text(row.teamName)
                    .font(Theme.Font.title())
                    .foregroundStyle(Theme.Color.textPrimary)
                Spacer()
                Eyebrow("\(row.memberCount) members")
            }

            HStack {
                metricColumn(label: "Active",   value: "\(row.activeDeals)")
                metricColumn(label: "Pipeline", value: shortBaht(row.pipelineValue))
                metricColumn(label: "Won",      value: shortBaht(row.wonValue))
                metricColumn(label: "Visit %",  value: "\(Int(row.visitCompletionRate))%")
            }
        }
        .card()
    }

    private func metricColumn(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Eyebrow(label)
            Text(value)
                .font(Theme.Font.body().weight(.semibold))
                .foregroundStyle(Theme.Color.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func shortBaht(_ value: Double) -> String {
        if value >= 1_000_000 { return String(format: "฿%.1fM", value / 1_000_000) }
        if value >= 1_000     { return String(format: "฿%.0fK", value / 1_000) }
        return String(format: "฿%.0f", value)
    }
}

@MainActor
private final class TeamKpiViewModel: ObservableObject {
    @Published var teamRows: [TeamPerformanceRow] = []
    @Published var isLoading = false

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let overview = try await DashboardRepository.shared.overview()
            self.teamRows = overview.teamPerformance ?? []
        } catch {
            print("[kpi/team] load failed: \(error)")
        }
    }
}
