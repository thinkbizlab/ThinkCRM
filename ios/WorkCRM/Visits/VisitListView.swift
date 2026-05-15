import SwiftUI

/// Smoke-test screen for Phase 2: login → see today's visits paginated. The
/// check-in / check-out / detail flows are stubbed for now and land in
/// follow-up commits.
public struct VisitListView: View {
    @StateObject private var model = VisitListViewModel()

    public init() {}

    public var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            if model.isLoading && model.visits.isEmpty {
                ProgressView().tint(Theme.Color.accent)
            } else if let error = model.errorMessage, model.visits.isEmpty {
                VStack(spacing: Theme.Spacing.md) {
                    Text(error)
                        .font(Theme.Font.body())
                        .foregroundStyle(Theme.Color.textSecondary)
                    Button(t(.commonRetry)) { Task { await model.refresh() } }
                        .buttonStyle(SecondaryButtonStyle())
                        .frame(maxWidth: 240)
                }
                .padding(Theme.Spacing.xl)
            } else if model.visits.isEmpty {
                Text(t(.visitsEmpty))
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        Eyebrow(t(.visitsTitle))
                            .padding(.horizontal, Theme.Spacing.lg)
                            .padding(.top, Theme.Spacing.lg)

                        ForEach(model.visits) { visit in
                            VisitRow(visit: visit)
                                .padding(.horizontal, Theme.Spacing.lg)
                                .task {
                                    if visit.id == model.visits.last?.id {
                                        await model.loadMoreIfNeeded()
                                    }
                                }
                        }

                        if model.isLoading {
                            ProgressView()
                                .tint(Theme.Color.accent)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, Theme.Spacing.md)
                        }
                    }
                    .padding(.bottom, Theme.Spacing.xl)
                }
                .refreshable { await model.refresh() }
            }
        }
        .task { await model.refresh() }
    }
}

// MARK: - Row

private struct VisitRow: View {
    let visit: Visit

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                if let no = visit.visitNo {
                    Eyebrow(no)
                }
                Spacer()
                statusChip
            }
            Text(visit.customer?.name ?? "—")
                .font(Theme.Font.title())
                .foregroundStyle(Theme.Color.textPrimary)
            if let objective = visit.objective, !objective.isEmpty {
                Text(objective)
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
                    .lineLimit(2)
            }
            if let plannedAt = visit.plannedAt {
                Text(plannedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(Theme.Font.caption())
                    .foregroundStyle(Theme.Color.textSecondary)
            }
        }
        .card()
    }

    private var statusChip: some View {
        let (label, color) = chipDescription
        return Text(label)
            .font(Theme.Font.eyebrow())
            .tracking(0.8)
            .foregroundStyle(color)
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.vertical, 4)
            .background(
                Capsule()
                    .strokeBorder(color.opacity(0.4), lineWidth: 1)
            )
    }

    private var chipDescription: (String, Color) {
        switch visit.status {
        case "PLANNED":     return ("PLANNED",     Theme.Color.textSecondary)
        case "CHECKED_IN":  return ("CHECKED IN",  Theme.Color.accent)
        case "CHECKED_OUT": return ("DONE",        Theme.Color.success)
        case "CANCELLED":   return ("CANCELLED",   Theme.Color.danger)
        default:            return (visit.status,  Theme.Color.textSecondary)
        }
    }
}

// MARK: - ViewModel

@MainActor
private final class VisitListViewModel: ObservableObject {
    @Published var visits: [Visit] = []
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?

    private let pageSize = 50
    private var offset = 0
    private var total = 0
    private var didExhaust = false

    func refresh() async {
        offset = 0
        total = 0
        didExhaust = false
        errorMessage = nil
        await load(reset: true)
    }

    func loadMoreIfNeeded() async {
        guard !isLoading, !didExhaust, visits.count < total else { return }
        await load(reset: false)
    }

    private func load(reset: Bool) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await VisitsRepository.shared.list(limit: pageSize, offset: offset)
            total = page.total
            offset += page.rows.count
            if reset {
                visits = page.rows
            } else {
                visits.append(contentsOf: page.rows)
            }
            if page.rows.isEmpty || visits.count >= total {
                didExhaust = true
            }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
