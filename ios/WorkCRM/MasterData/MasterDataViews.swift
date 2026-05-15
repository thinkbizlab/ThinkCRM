import SwiftUI

struct CustomerListView: View {
    @StateObject private var model = CustomerListViewModel()

    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            if model.isLoading && model.customers.isEmpty {
                ProgressView().tint(Theme.Color.accent)
            } else if model.customers.isEmpty {
                Text("No customers")
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        ForEach(model.customers) { c in
                            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                                if let code = c.customerCode {
                                    Eyebrow(code)
                                }
                                Text(c.name)
                                    .font(Theme.Font.body().weight(.semibold))
                                    .foregroundStyle(Theme.Color.textPrimary)
                                if let taxId = c.taxId, !taxId.isEmpty {
                                    Text(taxId)
                                        .font(Theme.Font.caption())
                                        .foregroundStyle(Theme.Color.textSecondary)
                                }
                            }
                            .card()
                            .padding(.horizontal, Theme.Spacing.lg)
                            .task {
                                if c.id == model.customers.last?.id {
                                    await model.loadMoreIfNeeded()
                                }
                            }
                        }
                        if model.isLoading {
                            ProgressView().tint(Theme.Color.accent)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, Theme.Spacing.md)
                        }
                    }
                    .padding(.vertical, Theme.Spacing.lg)
                }
                .refreshable { await model.refresh() }
            }
        }
        .navigationTitle("Customers")
        .task { await model.refresh() }
    }
}

@MainActor
private final class CustomerListViewModel: ObservableObject {
    @Published var customers: [Customer] = []
    @Published var isLoading = false
    private var page = 1
    private var totalPages = 1

    func refresh() async {
        page = 1
        await fetch(reset: true)
    }

    func loadMoreIfNeeded() async {
        guard !isLoading, page < totalPages else { return }
        page += 1
        await fetch(reset: false)
    }

    private func fetch(reset: Bool) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let result = try await MasterDataRepository.shared.customers(page: page, pageSize: 50, scope: "team")
            self.totalPages = result.totalPages
            if reset {
                self.customers = result.rows
            } else {
                self.customers.append(contentsOf: result.rows)
            }
        } catch {
            print("[customers] list failed: \(error)")
        }
    }
}

// MARK: - Items

struct ItemListView: View {
    @StateObject private var model = ItemListViewModel()

    var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            if model.isLoading && model.items.isEmpty {
                ProgressView().tint(Theme.Color.accent)
            } else if model.items.isEmpty {
                Text("No items")
                    .font(Theme.Font.body())
                    .foregroundStyle(Theme.Color.textSecondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        ForEach(model.items) { item in
                            HStack {
                                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                                    Eyebrow(item.itemCode)
                                    Text(item.name)
                                        .font(Theme.Font.body().weight(.semibold))
                                        .foregroundStyle(Theme.Color.textPrimary)
                                }
                                Spacer()
                                Text(formatBaht(item.unitPrice))
                                    .font(Theme.Font.body())
                                    .foregroundStyle(Theme.Color.accent)
                            }
                            .card()
                            .padding(.horizontal, Theme.Spacing.lg)
                            .task {
                                if item.id == model.items.last?.id {
                                    await model.loadMoreIfNeeded()
                                }
                            }
                        }
                        if model.isLoading {
                            ProgressView().tint(Theme.Color.accent)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, Theme.Spacing.md)
                        }
                    }
                    .padding(.vertical, Theme.Spacing.lg)
                }
                .refreshable { await model.refresh() }
            }
        }
        .navigationTitle("Items")
        .task { await model.refresh() }
    }

    private func formatBaht(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "THB"
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: value)) ?? "฿\(Int(value))"
    }
}

@MainActor
private final class ItemListViewModel: ObservableObject {
    @Published var items: [Item] = []
    @Published var isLoading = false
    private var offset = 0
    private var total = 0
    private let pageSize = 50

    func refresh() async {
        offset = 0
        total = 0
        await fetch(reset: true)
    }

    func loadMoreIfNeeded() async {
        guard !isLoading, items.count < total else { return }
        await fetch(reset: false)
    }

    private func fetch(reset: Bool) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await MasterDataRepository.shared.items(limit: pageSize, offset: offset)
            self.total = page.total
            self.offset += page.rows.count
            if reset { self.items = page.rows } else { self.items.append(contentsOf: page.rows) }
        } catch {
            print("[items] list failed: \(error)")
        }
    }
}
