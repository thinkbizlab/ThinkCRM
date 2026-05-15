import SwiftUI

/// Quick edit sheet matching the web Quick Update modal (PR #72):
/// Estimated Value / Next Follow-Up / Closed Date / Progress note.
///
/// Each field updates only if it differs from the source deal — that keeps
/// the audit changelog clean on the backend.
struct QuickUpdateSheet: View {
    let deal: Deal
    @Environment(\.dismiss) private var dismiss

    @State private var estimatedValue: String
    @State private var followUpAt: Date
    @State private var hasClosedAt: Bool
    @State private var closedAt: Date
    @State private var progressNote: String = ""

    @State private var isSubmitting = false
    @State private var errorMessage: String?

    init(deal: Deal) {
        self.deal = deal
        _estimatedValue = State(initialValue: String(format: "%.0f", deal.estimatedValue))
        _followUpAt     = State(initialValue: deal.followUpAt)
        _hasClosedAt    = State(initialValue: deal.closedAt != nil)
        _closedAt       = State(initialValue: deal.closedAt ?? Date())
    }

    var body: some View {
        Form {
            Section("Deal") {
                LabeledContent("Deal No", value: deal.dealNo)
                LabeledContent("Name",    value: deal.dealName)
            }

            Section("Estimated value (THB)") {
                TextField("Estimated value", text: $estimatedValue)
                    .keyboardType(.numberPad)
            }

            Section("Next follow-up") {
                DatePicker("Next follow-up", selection: $followUpAt, displayedComponents: .date)
            }

            Section {
                Toggle("Has closed date", isOn: $hasClosedAt)
                if hasClosedAt {
                    DatePicker("Closed", selection: $closedAt, displayedComponents: .date)
                }
            } header: { Text("Closed date") }

            Section("Progress note (optional)") {
                TextField("e.g. ส่งใบเสนอราคาแล้ว / Sent quotation", text: $progressNote, axis: .vertical)
                    .lineLimit(3, reservesSpace: true)
            }

            if let error = errorMessage {
                Section { Text(error).foregroundStyle(Theme.Color.danger) }
            }
        }
        .navigationTitle("Quick Update")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(t(.commonCancel)) { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                if isSubmitting {
                    ProgressView()
                } else {
                    Button("Save") { Task { await save() } }
                        .bold()
                }
            }
        }
    }

    private func save() async {
        isSubmitting = true
        defer { isSubmitting = false }
        errorMessage = nil
        do {
            let patch = buildPatch()
            if patchHasChanges(patch) {
                _ = try await DealsRepository.shared.update(deal.id, with: patch)
            }
            let trimmedNote = progressNote.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedNote.isEmpty {
                _ = try await DealsRepository.shared.postProgress(for: deal.id, note: trimmedNote)
            }
            dismiss()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func buildPatch() -> DealUpdateRequest {
        let parsedValue: Double? = {
            guard let v = Double(estimatedValue), v >= 0, v != deal.estimatedValue else { return nil }
            return v
        }()
        let nextFollowUp: String? = {
            guard !Calendar.current.isDate(followUpAt, inSameDayAs: deal.followUpAt) else { return nil }
            return ISO8601DateFormatter.iso8601String(from: followUpAt)
        }()
        let nextClosed: String? = {
            switch (hasClosedAt, deal.closedAt) {
            case (true, .none):
                return ISO8601DateFormatter.iso8601String(from: closedAt)
            case (true, .some(let existing)):
                return Calendar.current.isDate(closedAt, inSameDayAs: existing)
                    ? nil
                    : ISO8601DateFormatter.iso8601String(from: closedAt)
            case (false, .some):
                // Backend accepts an empty string as "clear me" per the
                // PATCH /deals/:id schema's nullable handling.
                return ""
            case (false, .none):
                return nil
            }
        }()
        return DealUpdateRequest(
            estimatedValue: parsedValue,
            followUpAt:     nextFollowUp,
            closedAt:       nextClosed,
            stageId:        nil
        )
    }

    private func patchHasChanges(_ patch: DealUpdateRequest) -> Bool {
        patch.estimatedValue != nil || patch.followUpAt != nil || patch.closedAt != nil || patch.stageId != nil
    }
}
