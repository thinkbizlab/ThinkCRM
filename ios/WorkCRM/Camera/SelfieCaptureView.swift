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
            guard let raw = info[.originalImage] as? UIImage else {
                parent.onCancel()
                return
            }
            // Resize before encoding. A modern iPhone shoots ~4032×3024 (12MP),
            // which produces a 3-5 MB JPEG at quality 0.8 — base64 then inflates
            // it by 33% and the request body easily blows past Vercel's 4.5 MB
            // serverless function limit, returning 413. Capping the longest
            // side at 1600 px + quality 0.7 stays comfortably under 800 KB on
            // the wire while still producing a readable selfie + GPS overlay
            // for the manager-visible watermark.
            let resized = raw.resizedToFit(maxDimension: 1600)
            guard let data = resized.jpegData(compressionQuality: 0.7) else {
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

private extension UIImage {
    /// Returns a downscaled copy with the longest side at most `maxDimension`.
    /// Preserves aspect ratio; uses scale=1 so the rendered pixels match the
    /// requested size (not @2x/@3x'd). No-op if the image is already smaller.
    func resizedToFit(maxDimension: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxDimension else { return self }
        let scale = maxDimension / longest
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: newSize, format: format).image { _ in
            self.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }
}
