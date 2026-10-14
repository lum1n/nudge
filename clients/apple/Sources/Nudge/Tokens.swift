// Where a client keeps its token. `pair` stores the token it gets, and every request and
// connection attempt reads it again; both are called on library threads.
import Foundation
import NudgeFFI

#if canImport(Security)
import Security
#endif

/// A token held in memory only.
public final class MemoryTokens: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?

    public init(_ token: String? = nil) {
        self.token = token
    }

    public func get() -> String? {
        lock.withLock { token }
    }

    public func set(token: String?) {
        lock.withLock { self.token = token }
    }
}

#if canImport(Security)
/// A token in the keychain, as a generic password for `service` and `account`, readable after
/// the device's first unlock and not synced or restored to another device.
public final class KeychainTokens: TokenStore, @unchecked Sendable {
    private let query: [String: Any]

    public init(service: String = "nudge", account: String) {
        query = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func get() -> String? {
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess,
            let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func set(token: String?) {
        SecItemDelete(query as CFDictionary)
        guard let token else { return }
        var item = query
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
}
#endif
