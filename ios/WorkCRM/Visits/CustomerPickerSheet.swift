import SwiftUI

/// Modal customer picker used by the visit-create / edit form.
/// Behavior mirrors the web client's customer search:
///   - 3-char minimum before hitting the backend (matches the API gate)
///   - 300 ms debounce so each keystroke doesn't burn a request
///   - "team" scope by default — same as the web visit-create modal
///
/// Selection is delivered via the `onPick` closure and the sheet dismisses.
struct CustomerPickerSheet: View {
    @Environment(\.dismiss) private var dismiss

    let onPick: (Customer) -> Void

    @State private var query: String = ""
    @State private var results: [Customer] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var searchTask: Task<Void, Never>? = nil

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Color.backgroundPrimary.ignoresSafeArea()
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    searchField
                    content
                }
                .padding(Theme.Spacing.lg)
            }
            .navigationTitle(t(.customerPickerTitle))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(t(.commonCancel)) { dismiss() }
                }
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Theme.Color.textSecondary)
            TextField(t(.customerPickerSearchPlaceholder), text: $query)
                .font(Theme.Font.body())
                .foregroundStyle(Theme.Color.textPrimary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onChange(of: query) { _, newValue in scheduleSearch(newValue) }
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
    }

    @ViewBuilder
    private var content: some View {
        if query.trimmingCharacters(in: .whitespaces).count < 3 {
            hint(t(.customerPickerHintShort))
        } else if isLoading {
            ProgressView()
                .tint(Theme.Color.accent)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage {
            hint(errorMessage)
        } else if results.isEmpty {
            hint(t(.customerPickerEmpty))
        } else {
            ScrollView {
                LazyVStack(spacing: Theme.Spacing.sm) {
                    ForEach(results) { customer in
                        Button {
                            onPick(customer)
                            dismiss()
                        } label: { row(for: customer) }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func row(for customer: Customer) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(customer.name)
                    .font(Theme.Font.body().weight(.semibold))
                    .foregroundStyle(Theme.Color.textPrimary)
                if let code = customer.customerCode, !code.isEmpty {
                    Text(code)
                        .font(Theme.Font.caption())
                        .foregroundStyle(Theme.Color.textSecondary)
                }
            }
            Spacer()
            if customer.disabled == true {
                Text("DISABLED")
                    .font(Theme.Font.eyebrow())
                    .foregroundStyle(Theme.Color.textSecondary)
            }
        }
        .card()
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(Theme.Font.body())
            .foregroundStyle(Theme.Color.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
            .padding(Theme.Spacing.lg)
    }

    /// Debounced search. Cancels the in-flight request when a new keystroke
    /// arrives so we only act on the user's most recent input.
    private func scheduleSearch(_ raw: String) {
        searchTask?.cancel()
        let q = raw.trimmingCharacters(in: .whitespaces)
        guard q.count >= 3 else {
            results = []
            errorMessage = nil
            isLoading = false
            return
        }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            await runSearch(q)
        }
    }

    @MainActor
    private func runSearch(_ q: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let rows = try await MasterDataRepository.shared.searchCustomers(q: q, limit: 20, scope: "team")
            if !Task.isCancelled { results = rows }
        } catch is CancellationError {
            // Newer search took over; ignore.
        } catch {
            results = []
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
