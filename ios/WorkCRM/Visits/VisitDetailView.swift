import SwiftUI

/// Visit landing screen. Surfaces customer, objective, planned time, status,
/// and the action buttons gated by the current `status`:
///   - PLANNED      → Check in
///   - CHECKED_IN   → Check out
///   - CHECKED_OUT  → (read-only summary)
///
/// Honours offline-queued actions for this visit by surfacing a "Pending sync"
/// banner — once it appears we don't re-offer the action button (we'd just
/// queue a second pending row, which the server would dedupe but the UX would
/// be confusing).
public struct VisitDetailView: View {
    public let visit: Visit
    @StateObject private var pending = PendingActionStore.shared
    @State private var showingCheckIn  = false
    @State private var showingCheckOut = false

    public init(visit: Visit) { self.visit = visit }

    public var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    header

                    if !pendingActionsForThisVisit.isEmpty {
                        pendingBanner
                    }

                    if let objective = visit.objective, !objective.isEmpty {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            Eyebrow("Objective")
                            Text(objective)
                                .font(Theme.Font.body())
                                .foregroundStyle(Theme.Color.textPrimary)
                                .thaiAwareLineSpacing()
                        }.card()
                    }

                    actionButton

                    if let result = visit.result, !result.isEmpty {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            Eyebrow("Result")
                            Text(result)
                                .font(Theme.Font.body())
                                .foregroundStyle(Theme.Color.textPrimary)
                                .thaiAwareLineSpacing()
                        }.card()
                    }
                }
                .padding(Theme.Spacing.lg)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingCheckIn) {
            NavigationStack { CheckInView(visit: visit) }
        }
        .sheet(isPresented: $showingCheckOut) {
            NavigationStack { CheckOutView(visit: visit) }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if let no = visit.visitNo { Eyebrow(no) }
            Text(visit.customer?.name ?? "—")
                .font(Theme.Font.display())
                .foregroundStyle(Theme.Color.textPrimary)
            if let plannedAt = visit.plannedAt {
                Text(plannedAt.formatted(date: .complete, time: .shortened))
                    .font(Theme.Font.caption())
                    .foregroundStyle(Theme.Color.textSecondary)
            }
        }
    }

    private var pendingBanner: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .foregroundStyle(Theme.Color.accent)
            Text(t(.visitPendingSync))
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

    @ViewBuilder
    private var actionButton: some View {
        let hasPending = !pendingActionsForThisVisit.isEmpty
        switch visit.status {
        case "PLANNED" where !hasPending:
            Button(t(.visitCheckIn)) { showingCheckIn = true }
                .buttonStyle(PrimaryButtonStyle())
        case "CHECKED_IN" where !hasPending:
            Button(t(.visitCheckOut)) { showingCheckOut = true }
                .buttonStyle(PrimaryButtonStyle())
        default:
            EmptyView()
        }
    }

    private var pendingActionsForThisVisit: [PendingAction] {
        pending.actionsForVisit(visit.id)
    }
}
