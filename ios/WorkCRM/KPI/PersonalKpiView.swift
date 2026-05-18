import SwiftUI

struct PersonalKpiView: View {
    @EnvironmentObject private var auth: AuthViewModel
    @StateObject private var model = PersonalKpiViewModel()

    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    header
                    if let entry = model.myTargetVsActual {
                        ringsRow(entry: entry)
                    } else if model.isLoading {
                        ProgressView().tint(Theme.Color.accent)
                            .frame(maxWidth: .infinity, minHeight: 200)
                    } else {
                        emptyState
                    }
                    if let summary = model.summary {
                        summaryGrid(kpi: summary.kpis)
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .refreshable { await model.load(repId: auth.session?.user.id) }
        }
        .task { await model.load(repId: auth.session?.user.id) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Eyebrow(t(.kpiPersonalTitle))
            Text(headerTitle)
                .font(Theme.Font.display())
                .foregroundStyle(Theme.Color.textPrimary)
            // The "last 5 days of the month" banner mirrors what the
            // kpi-alert cron uses to escalate notifications — show it here
            // so reps can see the urgency without waiting for the push.
            if isUrgent {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.Color.accent)
                    Text("\(DashboardRepository.daysLeftInMonth()) \(t(.kpiDaysLeft))")
                        .font(Theme.Font.body().weight(.semibold))
                        .foregroundStyle(Theme.Color.textPrimary)
                    Spacer()
                }
                .padding(Theme.Spacing.md)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.card)
                        .strokeBorder(Theme.Color.accent.opacity(0.4), lineWidth: 1)
                )
            }
        }
    }

    private var headerTitle: String {
        guard let key = model.summary?.period.month ?? model.monthKey else {
            return DashboardRepository.currentMonthKey()
        }
        let f = DateFormatter()
        f.locale = Locale.current
        f.dateFormat = "MMMM yyyy"
        let parts = key.split(separator: "-").compactMap { Int($0) }
        if parts.count == 2, let date = Calendar(identifier: .gregorian)
            .date(from: DateComponents(year: parts[0], month: parts[1], day: 1))
        {
            return f.string(from: date)
        }
        return key
    }

    private var isUrgent: Bool { DashboardRepository.daysLeftInMonth() <= 5 }

    @ViewBuilder
    private func ringsRow(entry: TargetVsActual) -> some View {
        // Prefer the dynamic per-role kpiMetrics array when the server emits
        // it. Older builds + tenants that haven't enabled any metric for the
        // signed-in user's role keep the legacy 3-ring layout below.
        if let metrics = entry.kpiMetrics, !metrics.isEmpty {
            HStack(alignment: .top, spacing: Theme.Spacing.lg) {
                ForEach(metrics.prefix(3)) { m in
                    KpiRing(
                        progress:      m.pct / 100.0,
                        label:         metricLabel(m),
                        primaryText:   formatKpiValue(m.actual, unit: m.unit),
                        secondaryText: formatKpiValue(m.target, unit: m.unit)
                    )
                }
            }
            .frame(maxWidth: .infinity)
        } else {
            HStack(alignment: .top, spacing: Theme.Spacing.lg) {
                KpiRing(
                    progress:      entry.progress.visits / 100.0,
                    label:         t(.kpiVisits),
                    primaryText:   String(Int(entry.actual.visits)),
                    secondaryText: "/ \(Int(entry.target.visits))"
                )
                KpiRing(
                    progress:      entry.progress.revenue / 100.0,
                    label:         t(.kpiRevenue),
                    primaryText:   shortBaht(entry.actual.revenue),
                    secondaryText: shortBaht(entry.target.revenue)
                )
                KpiRing(
                    progress:      entry.progress.newDealValue / 100.0,
                    label:         "Pipeline",
                    primaryText:   shortBaht(entry.actual.newDealValue),
                    secondaryText: shortBaht(entry.target.newDealValue)
                )
            }
            .frame(maxWidth: .infinity)
        }
    }

    /// Pick the tenant-resolved label appropriate for the device locale.
    /// Thai falls through to English when the tenant left the label blank
    /// (server already merged catalog defaults so neither side is empty).
    private func metricLabel(_ m: KpiMetric) -> String {
        let code = Locale.current.language.languageCode?.identifier ?? "en"
        return code == "th" ? m.labelTh : m.labelEn
    }

    /// Format an actual / target value per the metric's declared unit.
    /// Currency → ฿1.2M shorthand (reuse `shortBaht`); count → integer;
    /// percent → "85%"; minutes → "45m". Keeps the ring legible without
    /// the row chasing pixels.
    private func formatKpiValue(_ v: Double, unit: String) -> String {
        switch unit {
        case "currency": return shortBaht(v)
        case "percent":  return "\(Int(v.rounded()))%"
        case "minutes":  return "\(Int(v.rounded()))m"
        default:         return String(Int(v.rounded()))
        }
    }

    @ViewBuilder
    private func summaryGrid(kpi: KpiSummary) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Eyebrow("This month")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Theme.Spacing.md) {
                summaryCard(title: "Active deals", value: "\(kpi.activeDeals)")
                summaryCard(title: t(.kpiVisits), value: "\(kpi.visitsPlannedInPeriod)")
                summaryCard(title: "Won", value: shortBaht(kpi.wonValue))
                summaryCard(title: "Pipeline", value: shortBaht(kpi.pipelineValue))
            }
        }
    }

    private func summaryCard(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Eyebrow(title)
            Text(value)
                .font(Theme.Font.title())
                .foregroundStyle(Theme.Color.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: "target")
                .font(.system(size: 48))
                .foregroundStyle(Theme.Color.accent)
            Text("No KPI target set for this month")
                .font(Theme.Font.body())
                .foregroundStyle(Theme.Color.textSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: 180)
    }

    private func shortBaht(_ value: Double) -> String {
        if value >= 1_000_000 { return String(format: "฿%.1fM", value / 1_000_000) }
        if value >= 1_000     { return String(format: "฿%.0fK", value / 1_000) }
        return String(format: "฿%.0f", value)
    }
}

@MainActor
private final class PersonalKpiViewModel: ObservableObject {
    @Published var summary: DashboardOverview?
    @Published var myTargetVsActual: TargetVsActual?
    @Published var monthKey: String?
    @Published var isLoading = false

    func load(repId: String?) async {
        guard let repId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let overview = try await DashboardRepository.shared.overview(repId: repId)
            self.summary = overview
            self.monthKey = overview.period.month
            self.myTargetVsActual = overview.targetVsActual.first(where: { $0.userId == repId })
        } catch {
            print("[kpi] load failed: \(error)")
        }
    }
}
