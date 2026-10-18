// The servers this device owns (ADR 11), with a server token each, and the exe.dev token servers
// are made with. The addresses are in the user defaults, the tokens in the keychain like the
// player tokens; none is sent to a server but the one it belongs to.
import Foundation
import Nudge
import Observation

@MainActor @Observable
final class Servers {
    /// The addresses of the servers this device signed in to as an owner.
    private(set) var owned: [String]

    @ObservationIgnored private let defaults = UserDefaults.standard
    private static let ownedKey = "servers"

    init() {
        owned = (defaults.stringArray(forKey: Self.ownedKey) ?? []).sorted()
    }

    /// The server's own API, signed in as an owner when this device has a server token for it.
    func client(_ server: String) throws -> ServerClient {
        try ServerClient(server: server, tokens: tokens(server), clientName: "nudge-apple", platform: Push.platformName)
    }

    /// Keeps a server token, as setup and signing in as an owner give one; nil when the client
    /// stored it already.
    func remember(_ server: String, token: String? = nil) {
        if let token { tokens(server).set(token: token) }
        guard !owned.contains(server) else { return }
        owned = (owned + [server]).sorted()
        save()
    }

    /// Signs this device out of a server's own API, as far as it can be reached.
    func forget(_ server: String) async {
        try? await client(server).signOut()
        tokens(server).set(token: nil)
        owned.removeAll { $0 == server }
        save()
    }

    /// The owned server that holds a Wired network (other than `except`), if any: the home that
    /// new servers join. With `holding`, only one whose network has that member.
    func wiredRoot(except: String? = nil, holding member: String? = nil) async -> String? {
        for server in owned where server != except {
            guard let client = try? client(server), let state = try? await client.wired(), state.state == .root
            else { continue }
            if let member, !state.members.contains(where: { $0.name == member }) { continue }
            return server
        }
        return nil
    }

    /// The exe.dev token the person pasted, to make and remove servers with.
    var exeToken: String? {
        get { KeychainTokens(service: "nudge-exe", account: "exe.dev").get() }
        set { KeychainTokens(service: "nudge-exe", account: "exe.dev").set(token: newValue) }
    }

    /// The app's SSH key for exe.dev, made the first time. Signing in adds it to the person's
    /// account, and the exe.dev token is signed with it.
    func exeKey() throws -> String {
        let store = KeychainTokens(service: "nudge-exe", account: "key")
        if let key = store.get() { return key }
        let key = try exeNewKey().privateKey
        store.set(token: key)
        return key
    }

    private func tokens(_ server: String) -> KeychainTokens {
        KeychainTokens(service: "nudge-server", account: server.trimmingCharacters(in: ["/"]))
    }

    private func save() {
        defaults.set(owned, forKey: Self.ownedKey)
    }
}
