import SwiftUI
import CoreLocation

/// Shared form for creating and editing a Visit.
///
/// Modes:
///   - `.createPlanned`   → customer + date + objective required
///   - `.createUnplanned` → drop-in; customer is optional. If the rep doesn't
///                          pick one, the backend auto-creates a Prospect
///                          using the captured GPS so the visit has an FK target.
///   - `.edit(existing)`  → pre-populated with the existing visit. Backend only
///                          accepts edits on PLANNED visits; the form trusts the
///                          caller to gate that upstream.
///
/// On success the form dismisses and calls `onSaved(Visit)` so the host screen
/// can refresh its list / detail view.
public struct VisitFormView: View {
    public enum Mode: Equatable {
        case createPlanned
        case createUnplanned
        case edit(Visit)
    }

    @Environment(\.dismiss) private var dismiss

    public let initialMode: Mode
    public let onSaved: (Visit) -> Void

    // ── Form state ───────────────────────────────────────────────────────
    @State private var mode: Mode
    @State private var customer: Customer?
    @State private var plannedAt: Date
    @State private var objective: String
    @State private var siteLat: Double?
    @State private var siteLng: Double?

    @State private var isCustomerPickerOpen = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    public init(mode: Mode, onSaved: @escaping (Visit) -> Void) {
        self.initialMode = mode
        self.onSaved = onSaved
        _mode = State(initialValue: mode)
        switch mode {
        case .edit(let visit):
            _customer = State(initialValue: visit.customer.map { Customer(id: $0.id, customerCode: nil, name: $0.name, taxId: nil, disabled: nil) })
            _plannedAt = State(initialValue: visit.plannedAt ?? Date())
            _objective = State(initialValue: visit.objective ?? "")
            _siteLat = State(initialValue: visit.siteLat)
            _siteLng = State(initialValue: visit.siteLng)
        case .createPlanned, .createUnplanned:
            _customer = State(initialValue: nil)
            _plannedAt = State(initialValue: Date())
            _objective = State(initialValue: "")
            _siteLat = State(initialValue: nil)
            _siteLng = State(initialValue: nil)
        }
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                Theme.Color.backgroundPrimary.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                        if isCreateMode { modePicker }
                        customerField
                        datePicker
                        objectiveField
                        if case .createUnplanned = mode {
                            Text(t(.visitFormUnplannedNote))
                                .font(Theme.Font.caption())
                                .foregroundStyle(Theme.Color.textSecondary)
                                .thaiAwareLineSpacing()
                        }
                        if let errorMessage {
                            Text(errorMessage)
                                .font(Theme.Font.caption())
                                .foregroundStyle(Theme.Color.danger)
                        }
                    }
                    .padding(Theme.Spacing.lg)
                }
            }
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(t(.commonCancel)) { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(t(.visitFormSave)) { Task { await save() } }
                        .disabled(!canSave || isSaving)
                }
            }
            .sheet(isPresented: $isCustomerPickerOpen) {
                CustomerPickerSheet(onPick: { customer = $0 })
            }
            .task {
                // For unplanned creates we grab GPS up front so the backend has
                // a site to anchor the prospect/visit on submit. Best-effort —
                // if Location is denied the rep can still pick a customer.
                if case .createUnplanned = mode, siteLat == nil {
                    await captureGPS()
                }
            }
        }
    }

    // MARK: - Subviews

    private var modePicker: some View {
        Picker("", selection: Binding(
            get: { mode == .createUnplanned ? 1 : 0 },
            set: { mode = $0 == 1 ? .createUnplanned : .createPlanned }
        )) {
            Text(t(.visitFormModePlanned)).tag(0)
            Text(t(.visitFormModeUnplanned)).tag(1)
        }
        .pickerStyle(.segmented)
    }

    private var customerField: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Eyebrow(t(.visitFormCustomer) + (customerRequired ? " *" : ""))
            Button {
                isCustomerPickerOpen = true
            } label: {
                HStack {
                    Text(customer?.name ?? t(.visitFormCustomerPlaceholder))
                        .foregroundStyle(customer == nil ? Theme.Color.textSecondary : Theme.Color.textPrimary)
                        .font(Theme.Font.body())
                    Spacer()
                    Image(systemName: "chevron.right")
                        .foregroundStyle(Theme.Color.textSecondary)
                }
                .card()
            }
            .buttonStyle(.plain)
        }
    }

    private var datePicker: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Eyebrow(t(.visitFormPlannedAt))
            DatePicker("", selection: $plannedAt, displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.compact)
                .labelsHidden()
                .tint(Theme.Color.accent)
        }
    }

    private var objectiveField: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Eyebrow(t(.visitFormObjective) + (objectiveRequired ? " *" : ""))
            TextField(t(.visitFormObjectivePlaceholder), text: $objective, axis: .vertical)
                .font(Theme.Font.body())
                .foregroundStyle(Theme.Color.textPrimary)
                .lineLimit(3...6)
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
    }

    // MARK: - Computed state

    private var isCreateMode: Bool {
        switch mode {
        case .createPlanned, .createUnplanned: return true
        case .edit: return false
        }
    }

    private var customerRequired: Bool {
        // Planned creates and edits both require a customer. Unplanned creates
        // can elide it (server auto-creates a Prospect).
        switch mode {
        case .createPlanned, .edit: return true
        case .createUnplanned: return false
        }
    }

    private var objectiveRequired: Bool {
        // Mirrors backend zod: required on planned, optional on unplanned.
        // We still require it on edit to keep the field non-empty after edit.
        switch mode {
        case .createPlanned, .edit: return true
        case .createUnplanned: return false
        }
    }

    private var canSave: Bool {
        if customerRequired && customer == nil { return false }
        if objectiveRequired && objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        return true
    }

    private var navigationTitle: String {
        switch mode {
        case .createPlanned, .createUnplanned: return t(.visitFormAddTitle)
        case .edit: return t(.visitFormEditTitle)
        }
    }

    // MARK: - Save

    @MainActor
    private func save() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let saved: Visit
            switch mode {
            case .createPlanned:
                guard let cust = customer else { return }
                let req = PlannedVisitCreateRequest(
                    customerId: cust.id,
                    plannedAt:  plannedAt,
                    objective:  objective.trimmingCharacters(in: .whitespacesAndNewlines),
                    siteLat:    siteLat,
                    siteLng:    siteLng
                )
                saved = try await VisitsRepository.shared.createPlanned(req)

            case .createUnplanned:
                let trimmedObjective = objective.trimmingCharacters(in: .whitespacesAndNewlines)
                let req = UnplannedVisitCreateRequest(
                    customerId: customer?.id,
                    prospectId: nil,
                    plannedAt:  plannedAt,
                    objective:  trimmedObjective.isEmpty ? nil : trimmedObjective,
                    siteLat:    siteLat,
                    siteLng:    siteLng
                )
                saved = try await VisitsRepository.shared.createUnplanned(req)

            case .edit(let existing):
                let req = VisitUpdateRequest(
                    customerId: customer?.id != existing.customer?.id ? customer?.id : nil,
                    plannedAt:  plannedAt != existing.plannedAt ? plannedAt : nil,
                    objective:  objective.trimmingCharacters(in: .whitespacesAndNewlines) != (existing.objective ?? "")
                                ? objective.trimmingCharacters(in: .whitespacesAndNewlines)
                                : nil,
                    siteLat: siteLat != existing.siteLat ? siteLat : nil,
                    siteLng: siteLng != existing.siteLng ? siteLng : nil
                )
                saved = try await VisitsRepository.shared.update(id: existing.id, req)
            }
            onSaved(saved)
            dismiss()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    @MainActor
    private func captureGPS() async {
        do {
            let loc = try await LocationService.shared.currentLocation()
            siteLat = loc.coordinate.latitude
            siteLng = loc.coordinate.longitude
        } catch {
            // Silent — the form is still usable without GPS.
        }
    }
}
