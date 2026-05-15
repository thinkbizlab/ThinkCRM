import SwiftUI

/// TODO: paginated list view of Customers using `GET /api/v1/customers?page=&pageSize=`.
struct CustomerListView: View {
    var body: some View {
        StubView(title: "Customer master", systemImage: "building.2")
            .navigationTitle("Customers")
    }
}

/// TODO: paginated list view of Items using `GET /api/v1/items?limit=&offset=`
/// (opt-in pagination shipped with the Phase 1 backend prep).
struct ItemListView: View {
    var body: some View {
        StubView(title: "Item master", systemImage: "cube.box")
            .navigationTitle("Items")
    }
}

private struct StubView: View {
    let title: String
    let systemImage: String
    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()
            VStack(spacing: Theme.Spacing.md) {
                Image(systemName: systemImage)
                    .font(.system(size: 48))
                    .foregroundStyle(Theme.Color.accent)
                Text("\(title) — coming soon")
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
            }
        }
    }
}
