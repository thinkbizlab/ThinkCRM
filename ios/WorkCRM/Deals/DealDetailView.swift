import SwiftUI

struct DealDetailView: View {
    let deal: Deal
    @State private var progressUpdates: [DealProgressUpdate] = []
    @State private var isLoading = false
    @State private var showingQuickUpdate = false

    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    header
                    actions
                    progressSection
                }
                .padding(Theme.Spacing.lg)
            }
        }
        .navigationTitle(deal.dealNo)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingQuickUpdate) {
            NavigationStack { QuickUpdateSheet(deal: deal) }
                .presentationDetents([.medium, .large])
        }
        .task { await loadProgress() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Eyebrow(deal.dealNo)
            Text(deal.dealName)
                .font(Theme.Font.display())
                .foregroundStyle(Theme.Color.textPrimary)
            HStack(spacing: Theme.Spacing.md) {
                Label(formatBaht(deal.estimatedValue), systemImage: "banknote")
                    .foregroundStyle(Theme.Color.accent)
                Spacer()
                Label(deal.followUpAt.formatted(date: .abbreviated, time: .omitted), systemImage: "calendar")
                    .foregroundStyle(Theme.Color.textSecondary)
            }
            .font(Theme.Font.caption())
        }
        .card()
    }

    private var actions: some View {
        Button("Quick Update") { showingQuickUpdate = true }
            .buttonStyle(PrimaryButtonStyle())
    }

    @ViewBuilder
    private var progressSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Eyebrow("Progress")
            if isLoading && progressUpdates.isEmpty {
                ProgressView().tint(Theme.Color.accent)
            } else if progressUpdates.isEmpty {
                Text("No updates yet")
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
            } else {
                ForEach(progressUpdates) { entry in
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text(entry.note)
                            .font(Theme.Font.body())
                            .foregroundStyle(Theme.Color.textPrimary)
                        HStack {
                            Text(entry.createdBy?.fullName ?? "—")
                            Spacer()
                            Text(entry.createdAt.formatted(date: .abbreviated, time: .shortened))
                        }
                        .font(Theme.Font.caption())
                        .foregroundStyle(Theme.Color.textSecondary)
                    }
                    .card()
                }
            }
        }
    }

    private func loadProgress() async {
        isLoading = true
        defer { isLoading = false }
        do {
            progressUpdates = try await DealsRepository.shared.progressUpdates(for: deal.id)
        } catch {
            // Non-fatal — section just shows empty state. Could add a toast later.
            print("[deal] load progress failed: \(error)")
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
