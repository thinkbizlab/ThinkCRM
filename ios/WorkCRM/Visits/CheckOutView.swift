import SwiftUI

/// Composes the check-out flow: capture GPS, take a free-text result, enqueue.
/// No camera — selfies are check-in only.
public struct CheckOutView: View {
    public let visit: Visit
    @Environment(\.dismiss) private var dismiss

    @State private var result: String = ""
    @State private var isFinalising = false
    @State private var errorMessage: String?
    @State private var deniedPermission: PermissionKind?

    public init(visit: Visit) { self.visit = visit }

    public var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Eyebrow(visit.customer?.name ?? "—")
                    Text("Check-out result")
                        .font(Theme.Font.title())
                        .foregroundStyle(Theme.Color.textPrimary)
                }

                // Free-text outcome — matches what the web client sends to
                // `POST /visits/:id/checkout`'s `result` field.
                TextEditor(text: $result)
                    .scrollContentBackground(.hidden)
                    .background(Theme.Color.backgroundElevated)
                    .foregroundStyle(Theme.Color.textPrimary)
                    .frame(minHeight: 180)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.card)
                            .strokeBorder(Theme.Color.surfaceBorder, lineWidth: 0.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))

                if let error = errorMessage {
                    Text(error)
                        .font(Theme.Font.caption())
                        .foregroundStyle(Theme.Color.danger)
                        .multilineTextAlignment(.leading)
                }

                Spacer()

                Button(t(.visitCheckOut)) {
                    Task { await finalise() }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isFinalising)
            }
            .padding(Theme.Spacing.xl)
        }
        // Intercept location permission denial before CoreLocation throws a
        // raw kCLErrorDenied at the user.
        .sheet(item: $deniedPermission) { kind in
            PermissionDeniedSheet(kind: kind) {
                deniedPermission = nil
            }
            .presentationDetents([.medium])
        }
    }

    private func finalise() async {
        isFinalising = true
        defer { isFinalising = false }

        PermissionsManager.shared.refresh()
        if PermissionsManager.shared.isDenied(.location) {
            deniedPermission = .location
            return
        }

        do {
            let location = try await LocationService.shared.currentLocation()
            let action = PendingAction.newCheckOut(
                visitId:    visit.id,
                lat:        location.coordinate.latitude,
                lng:        location.coordinate.longitude,
                capturedAt: Date(),
                result:     result.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            await PendingActionStore.shared.enqueue(action)
            Task.detached { await SyncEngine.shared.drain() }
            BackgroundSync.schedule()
            dismiss()
        } catch LocationService.LocationError.authorizationDenied {
            PermissionsManager.shared.refresh()
            deniedPermission = .location
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
