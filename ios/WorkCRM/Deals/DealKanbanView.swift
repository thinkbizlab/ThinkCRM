import SwiftUI

/// Horizontal kanban board grouped by `DealStage`. Each column is a vertical
/// stack of cards; the whole board scrolls horizontally. Tap a card → detail;
/// "···" → Quick Update sheet (matches the web flow shipped in PR #73).
struct DealKanbanView: View {
    @StateObject private var model = DealKanbanViewModel()

    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            if model.isLoading && model.stages.isEmpty {
                ProgressView().tint(Theme.Color.accent)
            } else if let error = model.errorMessage, model.stages.isEmpty {
                VStack(spacing: Theme.Spacing.md) {
                    Text(error)
                        .font(Theme.Font.body())
                        .foregroundStyle(Theme.Color.textSecondary)
                    Button(t(.commonRetry)) { Task { await model.refresh() } }
                        .buttonStyle(SecondaryButtonStyle())
                        .frame(maxWidth: 240)
                }
                .padding(Theme.Spacing.xl)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: Theme.Spacing.md) {
                        ForEach(model.stages) { stage in
                            KanbanColumn(stage: stage, deals: model.deals(for: stage.id))
                                .frame(width: 280)
                        }
                    }
                    .padding(Theme.Spacing.lg)
                }
                .refreshable { await model.refresh() }
            }
        }
        // Declared once at the parent rather than inside KanbanColumn — the
        // column gets instantiated once per stage, so per-column registration
        // would push N identical destinations onto the same NavigationStack and
        // trigger SwiftUI's "declared earlier on the stack" warning.
        .navigationDestination(for: Deal.self) { d in
            DealDetailView(deal: d)
        }
        .task { await model.refresh() }
    }
}

// MARK: - Column

private struct KanbanColumn: View {
    let stage: DealStage
    let deals: [Deal]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                Eyebrow(stage.stageName)
                Spacer()
                Text("\(deals.count)")
                    .font(Theme.Font.caption().weight(.semibold))
                    .foregroundStyle(Theme.Color.textSecondary)
            }
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: Theme.Spacing.sm) {
                    ForEach(deals) { deal in
                        NavigationLink(value: deal) {
                            DealCard(deal: deal)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        // No .navigationDestination here — declared once on DealKanbanView so
        // the same destination isn't re-registered per column.
    }
}

// MARK: - Card

private struct DealCard: View {
    let deal: Deal
    @State private var showingQuickUpdate = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Eyebrow(deal.dealNo)
                Spacer()
                Button {
                    showingQuickUpdate = true
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Color.textSecondary)
                        // 44×44 hit area meets the Human Interface Guidelines
                        // minimum even though the glyph is small.
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Quick Update")
            }
            Text(deal.dealName)
                .font(Theme.Font.body().weight(.semibold))
                .foregroundStyle(Theme.Color.textPrimary)
                .lineLimit(2)
            HStack {
                Text(formatBaht(deal.estimatedValue))
                    .font(Theme.Font.caption())
                    .foregroundStyle(Theme.Color.accent)
                Spacer()
                Text(deal.followUpAt.formatted(date: .abbreviated, time: .omitted))
                    .font(Theme.Font.caption())
                    .foregroundStyle(Theme.Color.textSecondary)
            }
        }
        .card()
        .sheet(isPresented: $showingQuickUpdate) {
            NavigationStack { QuickUpdateSheet(deal: deal) }
                .presentationDetents([.medium, .large])
        }
    }

    private func formatBaht(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "THB"
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: value)) ?? "฿\(Int(value))"
    }
}

extension Deal: Hashable {
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

extension DealStage: Hashable {
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

// MARK: - ViewModel

@MainActor
private final class DealKanbanViewModel: ObservableObject {
    @Published var stages: [DealStage] = []
    @Published var deals: [Deal] = []
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?

    func deals(for stageId: String) -> [Deal] {
        deals.filter { $0.stageId == stageId && $0.status == "OPEN" }
            .sorted { $0.followUpAt < $1.followUpAt }
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        do {
            async let stagesTask = DealsRepository.shared.listStages()
            async let dealsTask  = DealsRepository.shared.listDeals(limit: 200, offset: 0)
            let (s, page) = try await (stagesTask, dealsTask)
            stages = s
            deals = page.rows
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
