import SwiftUI

/// Horizontal kanban board grouped by `DealStage`. Each column is a vertical
/// stack of cards; the whole board scrolls horizontally. Tap a card → detail;
/// "···" → Quick Update sheet (matches the web flow shipped in PR #73).
///
/// Filters mirror the web client's scope chips (`state.dealsFilter` in app.js):
/// search + owner scope + show-closed toggle, with overdue follow-ups flagged
/// visually on the card. Server-side scope is already enforced by
/// `listVisibleUserIds()` in the API; the client-side filter is purely a slice
/// of what we're already allowed to see.
struct DealKanbanView: View {
    @EnvironmentObject private var auth: AuthViewModel
    @StateObject private var model = DealKanbanViewModel()
    @State private var scope: DealScope = .all
    @State private var query: String = ""
    @State private var showClosed: Bool = false

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
                VStack(spacing: 0) {
                    filterBar
                    kanban
                }
            }
        }
        // .inline collapses the giant nav title — without it the kanban sits
        // ~50pt below the safe area, which is what looked like a "gap" before.
        .navigationBarTitleDisplayMode(.inline)
        // Declared once at the parent rather than inside KanbanColumn — the
        // column gets instantiated once per stage, so per-column registration
        // would push N identical destinations onto the same NavigationStack and
        // trigger SwiftUI's "declared earlier on the stack" warning.
        .navigationDestination(for: Deal.self) { d in
            DealDetailView(deal: d)
        }
        .task { await model.refresh() }
    }

    // MARK: Filter bar

    private var filterBar: some View {
        VStack(spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(DealScope.allCases, id: \.self) { s in
                    ScopeChip(label: s.label, isActive: scope == s) { scope = s }
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: Theme.Spacing.sm) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Color.textSecondary)
                    TextField(t(.dealsSearchPlaceholder), text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .foregroundStyle(Theme.Color.textPrimary)
                        .font(Theme.Font.body())
                }
                .padding(.horizontal, Theme.Spacing.md)
                .frame(height: 36)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.button, style: .continuous)
                        .fill(Theme.Color.backgroundElevated)
                )

                Toggle(isOn: $showClosed) {
                    Text(t(.dealsShowClosed))
                        .font(Theme.Font.caption().weight(.semibold))
                        .foregroundStyle(Theme.Color.textSecondary)
                }
                .toggleStyle(.switch)
                .tint(Theme.Color.accent)
                .labelsHidden()
                .accessibilityLabel(t(.dealsShowClosed))
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.sm)
    }

    // MARK: Kanban

    private var kanban: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: Theme.Spacing.md) {
                ForEach(visibleStages) { stage in
                    KanbanColumn(stage: stage, deals: filteredDeals(for: stage.id))
                        .frame(width: 280)
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.lg)
        }
        .refreshable { await model.refresh() }
    }

    private var visibleStages: [DealStage] {
        showClosed
            ? model.stages
            : model.stages.filter { !$0.isClosedWon && !$0.isClosedLost }
    }

    private func filteredDeals(for stageId: String) -> [Deal] {
        let me = auth.session?.user.id
        let q  = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return model.deals
            .filter { $0.stageId == stageId }
            .filter { showClosed || $0.status == "OPEN" }
            .filter { d in
                switch scope {
                case .all:  return true
                case .mine: return d.ownerId == me
                case .team: return d.ownerId != nil && d.ownerId != me
                }
            }
            .filter { d in
                guard !q.isEmpty else { return true }
                return d.dealNo.lowercased().contains(q) || d.dealName.lowercased().contains(q)
            }
            .sorted { $0.followUpAt < $1.followUpAt }
    }
}

// MARK: - Scope

private enum DealScope: CaseIterable, Hashable {
    case all, mine, team
    var label: String {
        switch self {
        case .all:  return t(.dealsScopeAll)
        case .mine: return t(.dealsScopeMine)
        case .team: return t(.dealsScopeTeam)
        }
    }
}

private struct ScopeChip: View {
    let label: String
    let isActive: Bool
    let onTap: () -> Void
    var body: some View {
        Button(action: onTap) {
            Text(label)
                .font(Theme.Font.caption().weight(.semibold))
                .foregroundStyle(isActive ? Theme.Color.textOnLight : Theme.Color.textPrimary)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, 6)
                .background(
                    Capsule().fill(isActive ? Theme.Color.textPrimary : Theme.Color.backgroundElevated)
                )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isActive ? [.isSelected, .isButton] : [.isButton])
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
    }
}

// MARK: - Card

private struct DealCard: View {
    let deal: Deal
    @State private var showingQuickUpdate = false

    private var isOverdue: Bool {
        deal.status == "OPEN" && deal.followUpAt < Date()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Eyebrow(deal.dealNo)
                if isOverdue {
                    Image(systemName: "flame.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.Color.danger)
                        .accessibilityLabel(t(.dealsOverdueLabel))
                }
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
                    .foregroundStyle(isOverdue ? Theme.Color.danger : Theme.Color.textSecondary)
            }
        }
        .padding(Theme.Spacing.lg)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                .fill(Theme.Color.backgroundElevated)
        )
        .overlay(
            // Red border only for overdue OPEN deals; everything else gets the
            // standard half-pixel surface border from .card(). Keeping it on a
            // .overlay rather than mutating .card() preserves the rest of the
            // card visuals when followUpAt drifts in/out of overdue.
            RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                .strokeBorder(
                    isOverdue ? Theme.Color.danger.opacity(0.65) : Theme.Color.surfaceBorder,
                    lineWidth: isOverdue ? 1.0 : 0.5
                )
        )
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

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        do {
            async let stagesTask = DealsRepository.shared.listStages()
            async let dealsTask  = DealsRepository.shared.listDeals(limit: 200, offset: 0)
            let (s, page) = try await (stagesTask, dealsTask)
            stages = s.sorted { $0.stageOrder < $1.stageOrder }
            deals = page.rows
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
