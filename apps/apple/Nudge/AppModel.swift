// The signed-in account and its client: one assistant on one server, the token in the keychain,
// views and the outbox in a SQLite file of their own. Push registration goes through here too.
import Foundation
import Nudge
import Observation

/// Where the app signs in: kept in the user defaults, the token in the keychain.
struct Account: Codable, Equatable {
    var server: String
    var assistant: String
    /// The assistant's display name, for titles.
    var assistantName: String

    var keychainAccount: String { "\(server)|\(assistant)" }
}

@MainActor @Observable
final class AppModel {
    private(set) var account: Account?
    private(set) var client: NudgeClient?
    private(set) var connection: Observed<ConnectionStatus>?
    private(set) var home: Observed<HomeUpdate>?
    /// Who the player is, once the server said.
    private(set) var me: MeInfo?
    /// Which native pushes the server sends; nil until asked, or when it sends none.
    private(set) var pushPlatforms: PushPlatforms?
    /// The room on screen, also chosen by tapping a notification.
    var selectedRoom: String?
    /// A pairing link opened while signed out, or for another server.
    var pendingLink: PairingLink?
    /// Why the app signed out on its own, for the sign-in screen.
    var signedOutBecause: String?

    @ObservationIgnored private var deviceToken: String?
    @ObservationIgnored private var registeredToken: String?
    @ObservationIgnored private let defaults = UserDefaults.standard
    private static let accountKey = "account"

    init() {
        if let data = defaults.data(forKey: Self.accountKey),
            let account = try? JSONDecoder().decode(Account.self, from: data)
        {
            start(account)
        }
    }

    /// Trades a pairing code for a token, and signs in.
    func signIn(server: String, assistant: Assistant, code: String) async throws {
        let account = Account(server: server, assistant: assistant.name, assistantName: assistant.displayName)
        let tokens = KeychainTokens(account: account.keychainAccount)
        let client = try NudgeClient(config: config(for: account), tokens: tokens)
        _ = try await client.pair(code: code)
        defaults.set(try JSONEncoder().encode(account), forKey: Self.accountKey)
        signedOutBecause = nil
        start(account, client: client)
        Push.requestPermission()
    }

    /// Forgets the token, the device's push registration and the cached views.
    func signOut(because reason: String? = nil) async {
        guard let account, let client else { return }
        // Cleared first: revoking the token closes the socket with 4401, which mustn't sign out
        // a second time.
        let device = registeredToken
        connection?.close()
        home?.close()
        self.account = nil
        self.client = nil
        connection = nil
        home = nil
        me = nil
        pushPlatforms = nil
        registeredToken = nil
        selectedRoom = nil
        signedOutBecause = reason
        defaults.removeObject(forKey: Self.accountKey)
        if let device {
            try? await client.unregisterDevice(token: device)
        }
        // Revoked on the server too; signed out here whether or not it can be reached.
        try? await client.signOut()
        client.disconnect()
        KeychainTokens(account: account.keychainAccount).set(token: nil)
        try? FileManager.default.removeItem(at: cacheURL(for: account))
    }

    /// The socket is closed while the app is in the background, so the server pushes instead.
    func setActive(_ active: Bool) {
        guard let client else { return }
        if active {
            client.connect()
            client.retryNow()
        } else {
            client.disconnect()
        }
    }

    /// From the push service: register it with the server once signed in.
    func didRegisterForPush(deviceToken: Data) {
        self.deviceToken = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await registerDevice() }
    }

    /// A tapped notification: open its room, if it is for this account's assistant.
    func open(assistant: String?, room: String?) {
        guard let room, assistant == nil || assistant == account?.assistant else { return }
        selectedRoom = room
    }

    /// A `nudge://pair` link: sign in with it, or ask first when signed in elsewhere.
    func handle(_ url: URL) {
        guard let link = PairingLink(url) else { return }
        pendingLink = link
    }

    private func start(_ account: Account, client existing: NudgeClient? = nil) {
        let client: NudgeClient
        if let existing {
            client = existing
        } else {
            guard let made = try? NudgeClient(
                config: config(for: account), tokens: KeychainTokens(account: account.keychainAccount))
            else { return }
            client = made
        }
        self.account = account
        self.client = client
        client.connect()
        connection = client.observeConnectionState()
        home = client.observeHomeState()
        Task {
            me = try? await client.me()
            pushPlatforms = try? await client.pushPlatforms()
            await registerDevice()
        }
        Push.registerIfAllowed()
    }

    private func registerDevice() async {
        guard let client, let deviceToken, deviceToken != registeredToken,
            pushPlatforms?.apns == true
        else { return }
        do {
            try await client.registerDevice(platform: .apns, token: deviceToken, environment: Push.environment)
            registeredToken = deviceToken
        } catch {
            // Tried again on the next start or token.
        }
    }

    private func config(for account: Account) -> ClientConfig {
        ClientConfig(
            server: account.server, assistant: account.assistant, clientName: "nudge-apple",
            clientVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
            platform: Push.platformName, cachePath: cacheURL(for: account).path)
    }

    private func cacheURL(for account: Account) -> URL {
        let directory = URL.applicationSupportDirectory.appending(path: "Nudge", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = account.keychainAccount.unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) ? String($0) : "_" }.joined()
        return directory.appending(path: "\(name).sqlite")
    }
}

extension NudgeError {
    /// What to tell the user.
    var explanation: String {
        switch self {
        case .Status(let status, let detail):
            status == 401 ? "That code didn't work. Ask for a new one." : detail
        case .Network(let detail): "Can't reach the server: \(detail)"
        case .Decode(let detail): "The server's answer made no sense: \(detail)"
        case .Config(let detail): detail
        }
    }
}

func explain(_ error: Error) -> String {
    (error as? NudgeError)?.explanation ?? error.localizedDescription
}
