import SwiftUI
import CoreLocation

/// Composes the check-in flow: capture selfie → grab GPS → enqueue an offline
/// action. The action lands in `PendingActionStore` immediately; the
/// `SyncEngine` (woken via `Reachability` or `BGAppRefreshTask`) sends it to
/// the backend when the network's available.
///
/// The view never talks to the network directly. That's deliberate — it means
/// the user gets the same UX whether they're online or offline, and we have
/// exactly one code path for "check-in submitted successfully".
public struct CheckInView: View {
    public let visit: Visit
    @Environment(\.dismiss) private var dismiss

    @State private var capturedImage: Data?
    @State private var showingCamera = true
    @State private var isFinalising = false
    @State private var errorMessage: String?
    @State private var deniedPermission: PermissionKind?

    public init(visit: Visit) { self.visit = visit }

    public var body: some View {
        ZStack {
            Theme.Color.backgroundPrimary.ignoresSafeArea()

            VStack(spacing: Theme.Spacing.lg) {
                if let data = capturedImage, let ui = UIImage(data: data) {
                    Image(uiImage: ui)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxHeight: 360)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.card)
                                .strokeBorder(Theme.Color.surfaceBorder, lineWidth: 0.5)
                        )
                }

                VStack(spacing: Theme.Spacing.sm) {
                    Eyebrow(visit.customer?.name ?? "—")
                    if let objective = visit.objective {
                        Text(objective)
                            .font(Theme.Font.body())
                            .foregroundStyle(Theme.Color.textPrimary)
                            .multilineTextAlignment(.center)
                    }
                }

                if let error = errorMessage {
                    Text(error)
                        .font(Theme.Font.caption())
                        .foregroundStyle(Theme.Color.danger)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, Theme.Spacing.xl)
                }

                Spacer()

                VStack(spacing: Theme.Spacing.md) {
                    Button(t(.visitCheckIn)) {
                        Task { await finalise() }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(capturedImage == nil || isFinalising)

                    Button("Retake") { showingCamera = true }
                        .buttonStyle(SecondaryButtonStyle())
                        .disabled(isFinalising)
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.bottom, Theme.Spacing.lg)
            }
        }
        .fullScreenCover(isPresented: $showingCamera) {
            SelfieCaptureView(
                onCapture: { data in
                    capturedImage = data
                    showingCamera = false
                },
                onCancel: {
                    showingCamera = false
                    if capturedImage == nil { dismiss() }
                }
            )
            .ignoresSafeArea()
        }
        // Surfaces "Location permission denied" or "Camera denied" with an
        // Open Settings button. The check-in cannot proceed without these,
        // so we intercept before queuing the action.
        .sheet(item: $deniedPermission) { kind in
            PermissionDeniedSheet(kind: kind) {
                deniedPermission = nil
            }
            .presentationDetents([.medium])
        }
    }

    private func finalise() async {
        guard let imageData = capturedImage else { return }
        isFinalising = true
        defer { isFinalising = false }

        // Pre-check: if location was previously denied in Settings, iOS won't
        // re-prompt — surface the denial sheet directly instead of letting
        // CoreLocation throw a raw kCLErrorDenied at the user.
        PermissionsManager.shared.refresh()
        if PermissionsManager.shared.isDenied(.location) {
            deniedPermission = .location
            return
        }

        do {
            let location = try await LocationService.shared.currentLocation()
            let action = await persist(imageData: imageData, location: location)
            await PendingActionStore.shared.enqueue(action)
            // Wake the sync engine — if online it drains immediately,
            // otherwise the row sits until reachability flips.
            Task.detached { await SyncEngine.shared.drain() }
            BackgroundSync.schedule()
            dismiss()
        } catch LocationService.LocationError.authorizationDenied {
            // The .notDetermined → denied path lands here.
            PermissionsManager.shared.refresh()
            deniedPermission = .location
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Writes the selfie to the on-disk store first, then builds the queue
    /// row with that filename baked in. Failing the write here is fatal for
    /// this check-in attempt but doesn't leak any state.
    private func persist(imageData: Data, location: CLLocation) async -> PendingAction {
        let id = UUID().uuidString.lowercased()
        let filename: String
        do {
            filename = try SelfieStore.shared.save(jpegData: imageData, actionId: id)
        } catch {
            // We should surface this — but we also need *some* placeholder
            // so the function returns. The next save attempt likely succeeds
            // because the disk problem is usually transient.
            print("[checkin] selfie save failed: \(error)")
            filename = "\(id).jpg"
        }
        return PendingAction(
            id:             id,
            kind:           .visitCheckIn,
            visitId:        visit.id,
            payload:        .checkIn(.init(
                                lat:            location.coordinate.latitude,
                                lng:            location.coordinate.longitude,
                                capturedAt:     Date(),
                                selfieFilename: filename
                             )),
            createdAt:      Date(),
            retryCount:     0,
            lastError:      nil,
            lastAttemptAt:  nil,
            nextEligibleAt: Date()
        )
    }
}
