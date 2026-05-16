import SwiftUI

/// Today's visit list — paginated, pull-to-refresh, with a per-row "Pending
/// sync" chip when the offline queue is holding actions for that visit and a
/// global footer when there's at least one pending action anywhere.
public struct VisitListView: View {
    @StateObject private var model     = VisitListViewModel()
    @StateObject private var pending   = PendingActionStore.shared
    @StateObject private var reach     = Reachability.shared

    public init() {}

    public var body: some View {
        ZStack(alignment: .bottom) {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            content

            if pending.pendingCount > 0 || !reach.isOnline {
                pendingFooter
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.bottom, Theme.Spacing.md)
            }
        }
        .task { await model.refresh() }
    }

    @ViewBuilder
    private var content: some View {
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
                        NavigationLink(value: visit) {
                            VisitRow(
                                visit: visit,
                                hasPending: pending.actionsForVisit(visit.id).isEmpty == false
                            )
                        }
                        .buttonStyle(.plain)
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
                .padding(.bottom, Theme.Spacing.xxl)   // breathing room above the footer
            }
            .refreshable { await model.refresh() }
            .navigationDestination(for: Visit.self) { v in
                VisitDetailView(visit: v)
            }
        }
    }

    private var pendingFooter: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: reach.isOnline ? "arrow.triangle.2.circlepath" : "wifi.slash")
                .foregroundStyle(reach.isOnline ? Theme.Color.accent : Theme.Color.danger)
                .accessibilityHidden(true)
            if reach.isOnline {
                Text("Pending: \(pending.pendingCount) · Syncing…")
                    .font(Theme.Font.caption().weight(.semibold))
                    .foregroundStyle(Theme.Color.textPrimary)
            } else {
                Text("\(t(.visitOffline)) · \(pending.pendingCount) pending")
                    .font(Theme.Font.caption().weight(.semibold))
                    .foregroundStyle(Theme.Color.textPrimary)
            }
            Spacer()
        }
        .padding(Theme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .fill(Theme.Color.backgroundElevated)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.card)
                        .strokeBorder(Theme.Color.surfaceBorder, lineWidth: 0.5)
                )
        )
        // Politely announce count + connectivity changes so a rep with
        // VoiceOver hears the queue draining without re-navigating.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

extension Visit: Hashable {
    // Hash on id only — the structural Equatable conformance synthesised
    // for the struct keeps `==` consistent, and id uniquely identifies a
    // visit across screens.
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

// MARK: - Row

private struct VisitRow: View {
    let visit: Visit
    let hasPending: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                if let no = visit.visitNo {
                    Eyebrow(no)
                }
                Spacer()
                if hasPending {
                    pendingChip
                }
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
                    .thaiAwareLineSpacing()
            }
            if let plannedAt = visit.plannedAt {
                Text(plannedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(Theme.Font.caption())
                    .foregroundStyle(Theme.Color.textSecondary)
            }
        }
        .card()
        // VoiceOver: announce the whole row as one element with a button trait.
        // Without this, swiping reads each Text in turn (5+ stops), which is
        // exhausting on a 30-visit list.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Opens visit detail")
    }

    private var accessibilityLabel: String {
        var parts: [String] = []
        if let no = visit.visitNo { parts.append(no) }
        parts.append(visit.customer?.name ?? "no customer")
        parts.append("status \(visit.status.replacingOccurrences(of: "_", with: " ").lowercased())")
        if hasPending { parts.append("pending sync") }
        if let plannedAt = visit.plannedAt {
            parts.append(plannedAt.formatted(date: .abbreviated, time: .shortened))
        }
        return parts.joined(separator: ", ")
    }

    private var pendingChip: some View {
        Text(t(.visitPendingSync).uppercased())
            .font(Theme.Font.eyebrow())
            .tracking(0.8)
            .foregroundStyle(Theme.Color.accent)
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.vertical, 4)
            .background(
                Capsule()
                    .strokeBorder(Theme.Color.accent.opacity(0.4), lineWidth: 1)
            )
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
