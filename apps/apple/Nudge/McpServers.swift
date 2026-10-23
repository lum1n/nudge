// A room's MCP servers, over the mcp extension's panel socket: the list as it changes, and what
// only people set: keys, sign-ins and which calls wait for approval. A key goes to the server and
// never comes back; the list says only whether one is set.
import Foundation
import Nudge
import Observation

/// Where an MCP server's key goes: a header, or an environment variable of its program.
struct McpKey: Decodable, Equatable, Hashable, Sendable {
    /// `header` or `env`.
    var placement: String
    var name: String
    var prefix: String?
    /// Whether the room set it, never the key.
    var set: Bool

    enum CodingKeys: String, CodingKey {
        case placement = "in"
        case name, prefix, set
    }
}

/// An MCP server the room's assistant can use: a remote one at `url`, or a program run as `command`.
struct McpServer: Decodable, Equatable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var useFor: String
    /// The URL, or the command line.
    var runs: String
    var url: String?
    var command: String?
    var keys: [McpKey]
    /// Which calls wait for approval: `writes`, `always` or `never`.
    var approval: String
    var addedBy: String
    /// Remote servers only: whether someone signed in with OAuth.
    var signedIn: Bool
    /// What went wrong the last time it was used.
    var problem: String?
    /// How many tools it has, once they were read.
    var tools: Int?
}

/// What an ``ObservedMcpServers`` shows: the socket's status, the room's servers once they came,
/// and the last change the extension refused.
struct McpServersState: Equatable, Sendable {
    var status: PanelStatus = .connecting
    var servers: [McpServer]?
    var error: String?
}

/// A sign-in the extension refused, or that the socket dropped before the answer came.
struct McpRefusal: Error, LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// A room's MCP servers, kept current; change them with the methods here. `close()` when done.
@MainActor @Observable
final class ObservedMcpServers {
    private(set) var value: McpServersState?
    @ObservationIgnored fileprivate var panel: Panel?
    @ObservationIgnored private var number = 0
    @ObservationIgnored private var next = 0
    /// Sign-ins waiting for their answer, by `ref`.
    @ObservationIgnored private var waiting: [String: CheckedContinuation<String?, Error>] = [:]

    func setKey(_ value: String, _ key: McpKey, of server: McpServer) {
        send("setKey", server, ["key": .string(key.name), "value": .string(value)])
    }
    func clearKey(_ key: McpKey, of server: McpServer) { send("clearKey", server, ["key": .string(key.name)]) }
    func setApproval(_ approval: String, for server: McpServer) {
        send("setApproval", server, ["approval": .string(approval)])
    }
    func signOut(_ server: McpServer) { send("signOut", server) }
    /// Reads its tools again, after a problem.
    func refresh(_ server: McpServer) { send("refresh", server) }
    func remove(_ server: McpServer) { send("remove", server) }

    /// Starts signing in to a remote server; `base` is the address this app reaches the Nudge
    /// server by, for the sign-in to come back to. The address to open in the browser, or nil
    /// when it was signed in already.
    func signIn(_ server: McpServer, base: String) async throws -> URL? {
        guard let panel else { throw McpRefusal(message: "Closed") }
        next += 1
        let ref = "r\(next)"
        let url = try await withCheckedThrowingContinuation { continuation in
            waiting[ref] = continuation
            send(panel, "signIn", server, ["base": .string(base), "ref": .string(ref)])
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(60))
                self?.answer(ref, .failure(McpRefusal(message: "No answer; try again")))
            }
        }
        return url.flatMap(URL.init(string:))
    }

    func close() {
        panel?.disconnect()
        panel = nil
        dropped()
    }

    private func send(_ type: String, _ server: McpServer, _ fields: [String: JSONValue] = [:]) {
        if let panel { send(panel, type, server, fields) }
    }

    private func send(_ panel: Panel, _ type: String, _ server: McpServer, _ fields: [String: JSONValue]) {
        var frame = fields
        frame["type"] = .string(type)
        frame["server"] = .string(server.id)
        try? panel.send(json: JSONValue.object(frame).json)
    }

    fileprivate func set(_ value: McpServersState, number: Int) {
        guard number > self.number else { return }
        self.number = number
        self.value = value
    }

    fileprivate func answer(_ ref: String, _ result: Result<String?, Error>) {
        waiting.removeValue(forKey: ref)?.resume(with: result)
    }

    /// The socket dropped: what waits gets no answer.
    fileprivate func dropped() {
        let dropped = waiting.values
        waiting = [:]
        for continuation in dropped {
            continuation.resume(throwing: McpRefusal(message: "The connection dropped; try again"))
        }
    }
}

private struct McpFrame: Decodable {
    var type: String
    var servers: [McpServer]?
    var url: String?
    var message: String?
    var ref: String?
}

private final class McpRelay: PanelListener, @unchecked Sendable {
    private weak var observed: ObservedMcpServers?
    // Calls come one at a time, in order, so the state and its number can be kept here.
    private var state = McpServersState()
    private var number = 0
    private var open = false
    init(_ observed: ObservedMcpServers) { self.observed = observed }

    func onStatus(status: PanelStatus) {
        state.status = status
        deliver()
        // While it opens, a sign-in waits for it; once it was open, or closed for good, it gets
        // no answer.
        let isOpen = status == .open
        let isClosed = if case .closed = status { true } else { false }
        defer { open = isOpen }
        if (open && !isOpen) || isClosed {
            Task { @MainActor [weak observed] in observed?.dropped() }
        }
    }

    func onFrame(json: String) {
        guard let frame = try? JSONDecoder().decode(McpFrame.self, from: Data(json.utf8)) else { return }
        // A frame with a `ref` answers a sign-in; the rest change the state.
        if let ref = frame.ref {
            let result: Result<String?, Error> =
                frame.type == "error" ? .failure(McpRefusal(message: frame.message ?? "Refused")) : .success(frame.url)
            Task { @MainActor [weak observed] in observed?.answer(ref, result) }
            return
        }
        switch frame.type {
        case "servers":
            guard let servers = frame.servers else { return }
            state.servers = servers
        case "ok": state.error = nil
        case "error": state.error = frame.message
        default: return
        }
        deliver()
    }

    private func deliver() {
        number += 1
        let state = state
        let number = number
        Task { @MainActor [weak observed] in observed?.set(state, number: number) }
    }
}

extension NudgeClient {
    /// A room's MCP servers; the room needs the mcp extension on, or the state closes with 4404.
    @MainActor
    func observeMcpServers(_ room: String) throws -> ObservedMcpServers {
        let observed = ObservedMcpServers()
        observed.panel = try openPanel(room: room, extension: "mcp", listener: McpRelay(observed))
        return observed
    }
}
