import Foundation
import Security

/// Keychain-backed storage for the access + refresh token pair, plus a snapshot
/// of the signed-in User. The tokens use
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` so they're available while the
/// device is unlocked but never sync to iCloud / migrate to a new device.
///
/// The User snapshot is stored as JSON in a separate Keychain entry so we can
/// hydrate `RootView` before the network is reachable (e.g. cold-launch in
/// airplane mode, the offline-mode happy path).
public struct AuthSession: Codable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let user: User
}

public final class TokenStore: @unchecked Sendable {
    public static let shared = TokenStore()

    private let service = "com.workstationoffice.workcrm"
    private let sessionKey = "session"

    private init() {}

    public func load() -> AuthSession? {
        guard let data = read(account: sessionKey) else { return nil }
        return try? JSONDecoder().decode(AuthSession.self, from: data)
    }

    public func save(_ session: AuthSession) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        write(data, account: sessionKey)
    }

    public func clear() {
        delete(account: sessionKey)
    }

    // MARK: - Raw Keychain operations

    private func write(_ data: Data, account: String) {
        // Replace any existing entry — simpler than detecting + branching add
        // vs update, and idempotent for our use case (login or token refresh).
        delete(account: account)
        let query: [String: Any] = [
            kSecClass as String:            kSecClassGenericPassword,
            kSecAttrService as String:      service,
            kSecAttrAccount as String:      account,
            kSecAttrAccessible as String:   kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String:        data
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    private func read(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String:            kSecClassGenericPassword,
            kSecAttrService as String:      service,
            kSecAttrAccount as String:      account,
            kSecReturnData as String:       true,
            kSecMatchLimit as String:       kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { return nil }
        return item as? Data
    }

    private func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String:            kSecClassGenericPassword,
            kSecAttrService as String:      service,
            kSecAttrAccount as String:      account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
