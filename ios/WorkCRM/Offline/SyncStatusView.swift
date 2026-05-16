import SwiftUI

/// Surfaces the offline queue's state so a rep can see what's pending and
/// take action on rows that have hit a permanent failure (4xx other than
/// 401/408/429). Available from More → Sync Status.
struct SyncStatusView: View {
    @StateObject private var pending = PendingActionStore.shared
    @StateObject private var reach   = Reachability.shared
    @State private var isDraining = false

    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    statusCard
                    if pending.actions.isEmpty {
                        Text("No pending actions")
                            .font(Theme.Font.body())
                            .foregroundStyle(Theme.Color.textSecondary)
                    } else {
                        ForEach(pending.actions) { action in
                            ActionRow(action: action)
                        }
                    }
                }
                .padding(Theme.Spacing.lg)
            }
        }
        .navigationTitle("Sync Status")
    }

    private var statusCard: some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: reach.isOnline ? "wifi" : "wifi.slash")
                .font(.system(size: 28))
                .foregroundStyle(reach.isOnline ? Theme.Color.accent : Theme.Color.danger)
            VStack(alignment: .leading, spacing: 2) {
                Text(reach.isOnline ? "Online" : "Offline")
                    .font(Theme.Font.title())
                    .foregroundStyle(Theme.Color.textPrimary)
                Text("\(pending.pendingCount) pending")
                    .font(Theme.Font.caption())
                    .foregroundStyle(Theme.Color.textSecondary)
            }
            Spacer()
            Button {
                Task {
                    isDraining = true
                    await SyncEngine.shared.drain()
                    isDraining = false
                }
            } label: {
                if isDraining {
                    ProgressView().tint(Theme.Color.textOnLight)
                } else {
                    Text("Sync now")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(!reach.isOnline || pending.actions.isEmpty || isDraining)
            .frame(width: 130)
        }
        .card()
    }
}

private struct ActionRow: View {
    let action: PendingAction
    @State private var showingConfirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Eyebrow(action.kind == .visitCheckIn ? "Check-in" : "Check-out")
                Spacer()
                if action.retryCount > 0 {
                    Text("\(action.retryCount) attempts")
                        .font(Theme.Font.eyebrow())
                        .tracking(0.8)
                        .foregroundStyle(action.lastError != nil ? Theme.Color.danger : Theme.Color.textSecondary)
                }
            }
            Text("Visit \(action.visitId)")
                .font(Theme.Font.body())
                .foregroundStyle(Theme.Color.textPrimary)
            Text(action.createdAt.formatted(date: .abbreviated, time: .shortened))
                .font(Theme.Font.caption())
                .foregroundStyle(Theme.Color.textSecondary)
            if let error = action.lastError {
                Text(error)
                    .font(Theme.Font.caption())
                    .foregroundStyle(Theme.Color.danger)
                    .lineLimit(3)
            }

            // Once a row has visibly failed, offer Retry now + Discard
            // side-by-side. Retry resets backoff and wakes the engine —
            // useful when the rep knows the server-side issue is fixed
            // (e.g. tenant config corrected, network recovered).
            if action.lastError != nil && action.retryCount >= 3 {
                HStack(spacing: Theme.Spacing.md) {
                    Button("Retry now") {
                        Task { await SyncEngine.shared.retryNow(actionId: action.id) }
                    }
                    .buttonStyle(SecondaryButtonStyle())

                    Button("Discard", role: .destructive) {
                        showingConfirm = true
                    }
                    .buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .card()
        .confirmationDialog(
            "Discard this action? The check-in will be lost.",
            isPresented: $showingConfirm,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) {
                Task { @MainActor in
                    // Capture the row state BEFORE removal so analytics
                    // gets the final retryCount + lastError snapshot.
                    let event = DiscardAnalytics.event(for: action)
                    PendingActionStore.shared.remove(id: action.id)
                    if case .checkIn(let p) = action.payload {
                        SelfieStore.shared.delete(filename: p.selfieFilename)
                    }
                    // Fire-and-forget — never blocks the UI.
                    Task.detached { await DiscardAnalytics.report([event]) }
                }
            }
            Button(t(.commonCancel), role: .cancel) {}
        }
    }
}
