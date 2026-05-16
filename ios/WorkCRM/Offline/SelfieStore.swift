import Foundation

/// Manages selfie JPEG files captured during offline check-ins. Files live at
/// `Documents/offline-selfies/<actionId>.jpg`. The store is deliberately stateless
/// (no in-memory index) — the source of truth for "does this selfie exist" is
/// the filesystem.
///
/// Why a separate store from `PendingActionStore`: selfies are large (~100-500 KB),
/// and we don't want to rewrite all of them every time the queue mutates.
public final class SelfieStore: @unchecked Sendable {
    public static let shared = SelfieStore()

    private let directory: URL

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        self.directory = docs.appendingPathComponent("offline-selfies", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// Persist a selfie payload. Returns the bare filename (not the full
    /// path) — `PendingAction.CheckInPayload.selfieFilename` stores this so
    /// the JSON queue stays portable across app reinstalls.
    public func save(jpegData: Data, actionId: String) throws -> String {
        let filename = "\(actionId).jpg"
        let url = directory.appendingPathComponent(filename, isDirectory: false)
        try jpegData.write(to: url, options: [.atomic])
        return filename
    }

    public func load(filename: String) throws -> Data {
        let url = directory.appendingPathComponent(filename, isDirectory: false)
        return try Data(contentsOf: url)
    }

    public func delete(filename: String) {
        let url = directory.appendingPathComponent(filename, isDirectory: false)
        try? FileManager.default.removeItem(at: url)
    }

    /// Encode a JPEG buffer as a `data:` URL ready to drop into the
    /// `CheckInRequest.selfieUrl` field. Done at sync time, not at capture
    /// time, so we never hold the base64 representation in memory longer
    /// than one HTTP request needs it.
    public static func dataUri(forJpeg data: Data) -> String {
        "data:image/jpeg;base64,\(data.base64EncodedString())"
    }
}
