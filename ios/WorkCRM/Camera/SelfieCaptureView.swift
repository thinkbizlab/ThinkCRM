import SwiftUI
import UIKit
import AVFoundation

/// Selfie capture sheet. Uses `UIImagePickerController` with the front camera
/// pre-selected — the simpler path than a custom AVCaptureSession preview,
/// and the user-facing UX (system camera chrome) is fine for the MVP. Swap
/// to a custom AVFoundation preview later if we need overlays.
///
/// The completion delivers JPEG-encoded `Data` at 80% quality — enough for
/// the watermarking + R2 path the backend runs, while keeping the offline
/// queue's disk footprint modest.
public struct SelfieCaptureView: UIViewControllerRepresentable {
    public typealias UIViewControllerType = UIImagePickerController

    public let onCapture: (Data) -> Void
    public let onCancel: () -> Void

    public init(onCapture: @escaping (Data) -> Void, onCancel: @escaping () -> Void) {
        self.onCapture = onCapture
        self.onCancel = onCancel
    }

    public func makeCoordinator() -> Coordinator { Coordinator(self) }

    public func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraDevice = UIImagePickerController.isCameraDeviceAvailable(.front) ? .front : .rear
        picker.cameraCaptureMode = .photo
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    public func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    public final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let parent: SelfieCaptureView
        public init(_ parent: SelfieCaptureView) { self.parent = parent }

        public func imagePickerController(_ picker: UIImagePickerController,
                                          didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            guard
                let image = info[.originalImage] as? UIImage,
                let data = image.jpegData(compressionQuality: 0.8)
            else {
                parent.onCancel()
                return
            }
            parent.onCapture(data)
        }

        public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onCancel()
        }
    }
}
