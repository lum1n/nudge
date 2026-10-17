// The device's key for pushes through a push relay, shared by the app, which gives its public half
// to every server, and the notification service extension, which opens each push with it. A push
// is sealed by the server (extensions/push/src/device-seal.ts) as `v1.<epk>.<iv>.<data>.<tag>`,
// base64url: AES-256-GCM under HKDF-SHA256 of X25519 between the push's own key and this one.
import Foundation

#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

enum PushKey {
    /// What a push says once opened, under the keys a direct APNs push has beside `aps`.
    struct Opened: Equatable {
        let assistant: String
        let roomId: String
        let kind: String
        let url: String
        let title: String
        let body: String
        let tag: String
    }

    /// The push's fields, if it was sealed for `privateKey` (32 bytes, base64url); nil otherwise.
    static func open(_ sealed: String, privateKey: String) -> Opened? {
        let parts = sealed.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 5, parts[0] == "v1",
            let own = Data(base64URL: privateKey),
            let ephemeral = Data(base64URL: parts[1]),
            let iv = Data(base64URL: parts[2]), iv.count == 12,
            let data = Data(base64URL: parts[3]),
            let tag = Data(base64URL: parts[4]),
            let secret = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: own),
            let theirs = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: ephemeral),
            let shared = try? secret.sharedSecretFromKeyAgreement(with: theirs)
        else { return nil }
        let salt = "\(parts[1]).\(secret.publicKey.rawRepresentation.base64URL)"
        let key = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: Data(salt.utf8), sharedInfo: Data("nudge push v1".utf8),
            outputByteCount: 32)
        guard let nonce = try? AES.GCM.Nonce(data: iv),
            let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: data, tag: tag),
            let plain = try? AES.GCM.open(box, using: key, authenticating: Data(salt.utf8)),
            let fields = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
            let assistant = fields["assistant"] as? String,
            let roomId = fields["roomId"] as? String,
            let kind = fields["kind"] as? String,
            let url = fields["url"] as? String,
            let title = fields["title"] as? String,
            let body = fields["body"] as? String,
            let tag = fields["tag"] as? String
        else { return nil }
        return Opened(
            assistant: assistant, roomId: roomId, kind: kind, url: url, title: title, body: body, tag: tag)
    }

    /// A new key pair, each half 32 bytes in base64url.
    static func generate() -> (publicKey: String, privateKey: String) {
        let key = Curve25519.KeyAgreement.PrivateKey()
        return (key.publicKey.rawRepresentation.base64URL, key.rawRepresentation.base64URL)
    }
}

#if canImport(Security)
import Security

extension PushKey {
    /// The keychain group the app and its notification service extension share; from Info.plist,
    /// where the build fills in the team's prefix.
    private static var accessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "NudgeKeychainGroup") as? String
    }

    private static func query(_ name: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "nudge.push",
            kSecAttrAccount as String: name,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    private static func read(_ name: String) -> String? {
        var search = query(name)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess,
            let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func write(_ name: String, _ value: String) {
        SecItemDelete(query(name) as CFDictionary)
        var item = query(name)
        item[kSecValueData as String] = Data(value.utf8)
        // The extension runs while the device is locked, once it was unlocked after starting.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    /// The private half, for the extension; nil before the app made one.
    static var storedPrivateKey: String? { read("private") }

    /// The device's key, made on first use and kept in the shared keychain.
    static func loadOrCreate() -> (publicKey: String, privateKey: String) {
        if let publicKey = read("public"), let privateKey = read("private") {
            return (publicKey, privateKey)
        }
        let made = generate()
        write("private", made.privateKey)
        write("public", made.publicKey)
        return made
    }
}
#endif

extension Data {
    init?(base64URL text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
