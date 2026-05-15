import SwiftUI

/// TODO: kanban board grouped by stage, calling `GET /api/v1/deals?limit=200&offset=0`.
/// Tap a card → DealDetailView. "···" button → QuickUpdateSheet matching PR #72.
struct DealKanbanView: View {
    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()
            VStack(spacing: Theme.Spacing.md) {
                Image(systemName: "rectangle.split.3x1")
                    .font(.system(size: 48))
                    .foregroundStyle(Theme.Color.accent)
                Text("Deal kanban — coming soon")
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
            }
        }
    }
}
