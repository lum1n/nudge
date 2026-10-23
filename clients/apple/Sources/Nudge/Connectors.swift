// A room's connectors (APIs the assistant may call), over the connectors extension's panel
// socket: the list as it changes, and what only people set: API keys, the local network, the
// calls that only read. A key goes to the server and never comes back; the list says only whether
// one is set.
import Foundation
import NudgeFFI
import Observation

/// Where a connector's API key goes: a header or a query parameter named `name`.
public struct ConnectorAuth: Codable, Equatable, Hashable, Sendable {
    /// `header` or `query`.
    public var placement: String
    public var name: String
    public var prefix: String?

    enum CodingKeys: String, CodingKey {
        case placement = "in"
        case name, prefix
    }
}

/// An API the room's assistant can call. `shared` ones are shared with every room and changed
/// only by unsharing them; `hasKey` says whether the room set an API key, never the key.
public struct Connector: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var baseUrl: String
    public var useFor: String
    /// The assistant tries it first, before anything else, for what `useFor` says.
    public var alwaysFirst: Bool
    public var docsUrl: String?
    /// What the assistant learned about using it.
    public var notes: String
    public var auth: ConnectorAuth?
    /// May reach this machine and the local network.
    public var allowPrivateNetwork: Bool
    /// `METHOD /path` calls that only read though they aren't GET; they run without approval.
    public var readPaths: [String]
    public var addedBy: String
    public var shared: Bool
    public var hasKey: Bool
}

/// What an ``ObservedConnectors`` shows: the socket's status, the room's connectors, then the
/// shared ones, once they came; whether the player is an admin (who may share them); and the last
/// change the extension refused.
public struct ConnectorsState: Equatable, Sendable {
    public var status: PanelStatus = .connecting
    public var connectors: [Connector]?
    public var admin = false
    public var error: String?
}

/// A room's connectors, kept current; change them with the methods here. `close()` when done.
@MainActor
public final class ObservedConnectors: Observed<ConnectorsState> {
    @ObservationIgnored fileprivate var panel: Panel?

    public func setKey(_ key: String, for connector: Connector) { send("setKey", connector, ["value": .string(key)]) }
    public func clearKey(of connector: Connector) { send("clearKey", connector) }
    public func allowPrivateNetwork(_ allow: Bool, for connector: Connector) {
        send("setPrivateNetwork", connector, ["allow": .bool(allow)])
    }
    public func setReadPaths(_ readPaths: [String], for connector: Connector) {
        send("setReadPaths", connector, ["readPaths": .array(readPaths.map(JSONValue.string))])
    }
    /// What the assistant uses it for.
    public func setUseFor(_ useFor: String, for connector: Connector) {
        send("setUseFor", connector, ["useFor": .string(useFor)])
    }
    /// Has the assistant try it first, before anything else, for what it's for.
    public func setAlwaysFirst(_ alwaysFirst: Bool, for connector: Connector) {
        send("setAlwaysFirst", connector, ["alwaysFirst": .bool(alwaysFirst)])
    }
    public func remove(_ connector: Connector) { send("remove", connector) }
    /// For admins: every room may use it then.
    public func share(_ connector: Connector) { send("share", connector) }
    public func unshare(_ connector: Connector) { send("unshare", connector) }

    private func send(_ type: String, _ connector: Connector, _ fields: [String: JSONValue] = [:]) {
        var frame = fields
        frame["connector"] = .string(connector.id)
        panel?.input(type, frame)
    }

    override public func close() {
        panel?.disconnect()
        panel = nil
        super.close()
    }
}

private struct WireConnector: Decodable {
    var id: String
    var name: String
    var baseUrl: String
    var useFor: String
    var alwaysFirst: Bool?
    var docsUrl: String?
    var notes: String?
    var auth: ConnectorAuth?
    var allowPrivateNetwork: Bool?
    var readPaths: [String]?
    var addedBy: String?
    var shared: Bool?
    var hasKey: Bool?

    var connector: Connector {
        Connector(
            id: id, name: name, baseUrl: baseUrl, useFor: useFor, alwaysFirst: alwaysFirst ?? false,
            docsUrl: docsUrl, notes: notes ?? "", auth: auth,
            allowPrivateNetwork: allowPrivateNetwork ?? false, readPaths: readPaths ?? [], addedBy: addedBy ?? "",
            shared: shared ?? false, hasKey: hasKey ?? false)
    }
}

private final class ConnectorsRelay: PanelListener, @unchecked Sendable {
    let relay: Relay<ConnectorsState>
    // Calls come one at a time, in order, so the state can be kept here.
    private var state = ConnectorsState()
    init(_ relay: Relay<ConnectorsState>) { self.relay = relay }

    func onStatus(status: PanelStatus) {
        state.status = status
        relay.deliver(state)
    }

    func onFrame(json: String) {
        guard let frame = JSONValue(json: json) else { return }
        switch frame["type"]?.string {
        case "connectors":
            guard let connectors = frame["connectors"]?.decode([WireConnector].self) else { return }
            state.connectors = connectors.map(\.connector)
            state.admin = frame["admin"]?.bool ?? false
        case "ok": state.error = nil
        case "error": state.error = frame["message"]?.string
        default: return
        }
        relay.deliver(state)
    }
}

extension NudgeClient {
    /// A room's connectors; the room needs the connectors extension on, or the state closes with
    /// 4404.
    @MainActor
    public func observeConnectors(_ room: String) throws -> ObservedConnectors {
        let observed = ObservedConnectors()
        let panel = try openPanel(room: room, extension: "connectors", listener: ConnectorsRelay(Relay(observed)))
        observed.panel = panel
        observed.stop = { panel.disconnect() }
        return observed
    }
}
