// The signed-in account and its clients: the player's home, one assistant on one server, and the
// assistants they joined from there (ADR 10). Tokens are in the keychain, each client's views and
// outbox in a SQLite file of its own. Push registration goes through here too.
import Foundation
import Nudge
import Observation

/// An assistant the app is signed in to: the home is kept in the user defaults, the assistants
/// joined from it too, and the tokens in the keychain.
struct Account: Codable, Equatable, Hashable {
    var server: String
    var assistant: String
    /// The assistant's display name, for titles.
    var assistantName: String

    var keychainAccount: String { "\(server)|\(assistant)" }

    func isAt(server: String, assistant: String) -> Bool {
        self.server.trimmingCharacters(in: ["/"]) == server.trimmingCharacters(in: ["/"])
            && self.assistant == assistant
    }
}

/// A room of one of the signed-in assistants.
struct RoomRef: Hashable {
    var account: String
    var room: String
}

/// A signed-in assistant with its client and the views every screen needs.
@MainActor @Observable
final class Session {
    let account: Account
    let client: NudgeClient
    let connection: Observed<ConnectionStatus>
    let home: Observed<HomeUpdate>
    /// Who the player is there, once the server said.
    var me: MeInfo?
    /// Which native pushes the server sends; nil until asked, or when it sends none.
    var pushPlatforms: PushPlatforms?
    @ObservationIgnored var registeredToken: String?
    /// What the server knows the device by: the APNs token, or the relay's handle for it.
    @ObservationIgnored var registeredDevice: String?

    init(account: Account, client: NudgeClient) {
        self.account = account
        self.client = client
        client.connect()
        connection = client.observeConnectionState()
        home = client.observeHomeState()
    }

    func close() {
        connection.close()
        home.close()
        client.disconnect()
    }
}

@MainActor @Observable
final class AppModel {
    /// The player's home.
    private(set) var session: Session?
    /// The assistants the player joined from home, that this device is signed in to.
    private(set) var places: [Session] = []
    /// Where the player joined, as their home says; nil until it did, or without federation there.
    private(set) var memberships: Memberships?
    /// The room on screen, also chosen by tapping a notification.
    var selectedRoom: RoomRef?
    /// A pairing link opened while signed out, or for another server.
    var pendingLink: PairingLink?
    /// A join link: an admin elsewhere invited the player.
    var pendingJoin: JoinLink?
    /// Why the app signed out on its own, for the sign-in screen.
    var signedOutBecause: String?

    var account: Account? { session?.account }
    var client: NudgeClient? { session?.client }
    var connection: Observed<ConnectionStatus>? { session?.connection }
    /// Who the player is at home.
    var me: MeInfo? { session?.me }
    var pushPlatforms: PushPlatforms? { session?.pushPlatforms }

    /// Every signed-in assistant, home first.
    var sessions: [Session] { (session.map { [$0] } ?? []) + places }

    @ObservationIgnored private var deviceToken: String?
    @ObservationIgnored private var syncing = false
    @ObservationIgnored private let defaults = UserDefaults.standard
    private static let accountKey = "account"
    private static let placesKey = "places"

    init() {
        if let data = defaults.data(forKey: Self.accountKey),
            let account = try? JSONDecoder().decode(Account.self, from: data)
        {
            start(account)
        }
    }

    func session(for account: String) -> Session? {
        sessions.first { $0.account.keychainAccount == account }
    }

    /// Trades a pairing code for a token, and signs in.
    func signIn(server: String, assistant: Assistant, code: String) async throws {
        let account = Account(server: server, assistant: assistant.name, assistantName: assistant.displayName)
        let tokens = KeychainTokens(account: account.keychainAccount)
        let client = try NudgeClient(config: config(for: account), tokens: tokens)
        let entered = code.trimmingCharacters(in: .whitespacesAndNewlines)
        if entered.hasPrefix("nudge_") {
            // A token from `nudge token <player>` signs in as it is; checked before it is kept.
            tokens.set(token: entered)
            do {
                _ = try await client.me()
            } catch {
                tokens.set(token: nil)
                throw error
            }
        } else {
            _ = try await client.pair(code: entered)
        }
        defaults.set(try JSONEncoder().encode(account), forKey: Self.accountKey)
        signedOutBecause = nil
        start(account, client: client)
        Push.requestPermission()
    }

    /// Forgets the tokens, the device's push registrations and the cached views, everywhere.
    func signOut(because reason: String? = nil) async {
        guard let session else { return }
        // Cleared first: revoking the token closes the socket with 4401, which mustn't sign out
        // a second time.
        let places = places
        self.session = nil
        self.places = []
        memberships = nil
        selectedRoom = nil
        signedOutBecause = reason
        defaults.removeObject(forKey: Self.accountKey)
        defaults.removeObject(forKey: Self.placesKey)
        for place in places { await forget(place) }
        await forget(session)
    }

    /// The socket is closed while the app is in the background, so the server pushes instead.
    func setActive(_ active: Bool) {
        for session in sessions {
            if active {
                session.client.connect()
                session.client.retryNow()
            } else {
                session.client.disconnect()
            }
        }
        if active { Task { await syncPlaces() } }
    }

    /// From the push service: register it with every server once signed in.
    func didRegisterForPush(deviceToken: Data) {
        self.deviceToken = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { for session in sessions { await registerDevice(session) } }
    }

    /// The session a push is for: by the `account` it carries, or, from a server that sends none,
    /// by the assistant's name, which two servers may share.
    private func session(forPush account: String?, assistant: String?) -> Session? {
        if let account, let session = sessions.first(where: { $0.client.pushAccount() == account }) {
            return session
        }
        return sessions.first(where: { assistant == nil || $0.account.assistant == assistant })
    }

    /// A tapped notification: open its room, at the assistant it came from.
    func open(account: String?, assistant: String?, room: String?) {
        guard let room, let session = session(forPush: account, assistant: assistant) else { return }
        selectedRoom = RoomRef(account: session.account.keychainAccount, room: room)
    }

    /// Whether the room a notification is about is on screen.
    func showing(account: String?, assistant: String?, room: String?) -> Bool {
        guard let room, let shown = selectedRoom, shown.room == room else { return false }
        return session(forPush: account, assistant: assistant)?.account.keychainAccount == shown.account
    }

    /// A `nudge://pair` link: sign in with it, or ask first when signed in elsewhere. A
    /// `nudge://join` link: ask to join that assistant from home.
    func handle(_ url: URL) {
        if let link = PairingLink(url) { pendingLink = link }
        if let link = JoinLink(url) { pendingJoin = link }
    }

    /// Joins the assistant a link names, with the home vouching for the player; an admin there
    /// must have invited their address.
    func join(_ link: JoinLink) async throws {
        guard let home = session else { return }
        if home.account.isAt(server: link.server, assistant: link.assistant) {
            throw JoinProblem.home
        }
        if !places.contains(where: { $0.account.isAt(server: link.server, assistant: link.assistant) }) {
            let joined = try await join(from: home, server: link.server, assistant: link.assistant)
            places.append(joined)
            savePlaces()
        }
        memberships = try? await home.client.memberships()
    }

    /// Starts or stops carrying the player's own memory to an assistant they joined.
    func carryMemory(_ membership: Membership, _ carry: Bool) async throws {
        guard let home = session else { return }
        _ = try await home.client.carryMemory(server: membership.server, assistant: membership.assistant, carry: carry)
        memberships = try await home.client.memberships()
    }

    /// Stops the home sending the player's profile and memory there, and signs this device out of it.
    func leave(_ membership: Membership) async throws {
        guard let home = session else { return }
        try await home.client.leave(server: membership.server, assistant: membership.assistant)
        let gone = places.filter { $0.account.isAt(server: membership.server, assistant: membership.assistant) }
        places.removeAll { place in gone.contains { $0 === place } }
        savePlaces()
        for place in gone { await forget(place) }
        memberships = try? await home.client.memberships()
    }

    private func start(_ account: Account, client existing: NudgeClient? = nil) {
        guard let session = open(account, client: existing) else { return }
        self.session = session
        // The assistants joined, as this device last knew them, until home says.
        places = savedPlaces().compactMap { place in
            KeychainTokens(account: place.keychainAccount).get() == nil ? nil : open(place)
        }
        Push.registerIfAllowed()
        Task { await syncPlaces() }
    }

    /// A client of `account`, connected, its player and pushes asked for.
    private func open(_ account: Account, client existing: NudgeClient? = nil) -> Session? {
        let client: NudgeClient
        if let existing {
            client = existing
        } else {
            guard let made = try? NudgeClient(
                config: config(for: account), tokens: KeychainTokens(account: account.keychainAccount))
            else { return nil }
            client = made
        }
        let session = Session(account: account, client: client)
        Task {
            session.me = try? await client.me()
            session.pushPlatforms = try? await client.pushPlatforms()
            await registerDevice(session)
        }
        return session
    }

    /// Matches the assistants this device is in to the memberships at home: joins the ones it
    /// isn't in yet (a membership needs no invite again), and signs out of ones left elsewhere.
    private func syncPlaces() async {
        guard let home = session, !syncing else { return }
        syncing = true
        defer { syncing = false }
        let found: Memberships
        do {
            found = try await home.client.memberships()
        } catch NudgeError.Status(404, _) {
            // No federation at home: nobody joined anything from there.
            memberships = nil
            return
        } catch {
            return
        }
        guard session === home else { return }
        memberships = found
        let kept = places.filter { place in
            found.memberships.contains { place.account.isAt(server: $0.server, assistant: $0.assistant) }
        }
        let gone = places.filter { place in !kept.contains { $0 === place } }
        var added: [Session] = []
        for membership in found.memberships
        where !kept.contains(where: { $0.account.isAt(server: membership.server, assistant: membership.assistant) }) {
            if let joined = try? await join(from: home, server: membership.server, assistant: membership.assistant) {
                added.append(joined)
            }
        }
        places = kept + added
        savePlaces()
        for place in gone { await forget(place) }
    }

    /// Signs in to an assistant with the home's assertion.
    private func join(from home: Session, server: String, assistant: String) async throws -> Session {
        let name = (try? await listAssistants(server: server))?.first { $0.name == assistant }?.displayName
        let account = Account(server: server, assistant: assistant, assistantName: name ?? assistant)
        let client = try NudgeClient(
            config: config(for: account), tokens: KeychainTokens(account: account.keychainAccount))
        _ = try await client.join(assertion: try await home.client.vouchFor(server: server, assistant: assistant))
        return open(account, client: client)!
    }

    /// Signs a session out on its server, as far as it can be reached, and drops what is kept of it.
    private func forget(_ session: Session) async {
        if let device = session.registeredDevice {
            try? await session.client.unregisterDevice(token: device)
        }
        try? await session.client.signOut()
        session.close()
        KeychainTokens(account: session.account.keychainAccount).set(token: nil)
        try? FileManager.default.removeItem(at: cacheURL(for: session.account))
    }

    /// Registers the APNs token with a server: directly when it sends to this app itself, else
    /// through the push relay this build knows, if the server sends through it too. Pushes from
    /// the relay are sealed for the device's key, which the notification service extension opens.
    private func registerDevice(_ session: Session) async {
        guard let deviceToken, deviceToken != session.registeredToken, let pushPlatforms = session.pushPlatforms
        else { return }
        let client = session.client
        do {
            if pushPlatforms.apns {
                try await client.registerDevice(platform: .apns, token: deviceToken, environment: Push.environment)
                session.registeredDevice = deviceToken
            } else {
                guard let relay = Push.relay,
                    pushPlatforms.relays.contains(where: { $0.trimmingCharacters(in: ["/"]) == relay })
                else { return }
                let handle = try await registerWithRelay(
                    relay: relay, platform: .apns, token: deviceToken, environment: Push.environment)
                try await client.registerRelayDevice(
                    relay: relay, handle: handle, deviceKey: PushKey.loadOrCreate().publicKey)
                session.registeredDevice = handle
            }
            session.registeredToken = deviceToken
        } catch {
            // Tried again on the next start or token.
        }
    }

    private func savedPlaces() -> [Account] {
        defaults.data(forKey: Self.placesKey).flatMap { try? JSONDecoder().decode([Account].self, from: $0) } ?? []
    }

    private func savePlaces() {
        defaults.set(try? JSONEncoder().encode(places.map(\.account)), forKey: Self.placesKey)
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

enum JoinProblem: LocalizedError {
    case home

    var errorDescription: String? { "That is your home." }
}

extension NudgeError {
    /// What to tell the user.
    var explanation: String {
        switch self {
        case .Status(let status, let detail):
            status == 401
                ? "That didn't work. A pairing code from `nudge pair <your name>` works once, for ten minutes; a token from `nudge token <your name>` until it is revoked."
                : detail
        case .Network(let detail): "Can't reach the server: \(detail)"
        case .Decode(let detail): "The server's answer made no sense: \(detail)"
        case .Config(let detail): detail
        }
    }
}

func explain(_ error: Error) -> String {
    (error as? NudgeError)?.explanation ?? error.localizedDescription
}
