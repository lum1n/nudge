// A room's shared lists, over the lists extension's panel socket: the lists as they change, and
// the edits a member can make. The socket reconnects on its own and the extension sends the
// lists again each time.
import Foundation
import NudgeFFI
import Observation

/// An item on a list.
public struct ListItem: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var text: String
    public var done: Bool
    /// The display name of whoever added it.
    public var by: String
    /// Milliseconds since the epoch.
    public var at: Double
}

/// One of a room's lists; names are unique in a room, and lower case.
public struct NudgeList: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var name: String
    public var items: [ListItem]
    public var id: String { name }
}

/// What an ``ObservedLists`` shows: the socket's status, the lists once they came, and the last
/// edit the extension refused.
public struct ListsState: Equatable, Sendable {
    public var status: PanelStatus = .connecting
    public var lists: [NudgeList]?
    public var error: String?
}

/// A room's lists, kept current; edit them with the methods here. `close()` when done.
@MainActor
public final class ObservedLists: Observed<ListsState> {
    @ObservationIgnored fileprivate var panel: Panel?

    public func add(_ text: String, to list: String) { send(["type": "add", "list": list, "text": text]) }
    public func toggle(_ item: ListItem, in list: String) { send(["type": "toggle", "list": list, "id": item.id]) }
    public func remove(_ item: ListItem, from list: String) { send(["type": "remove", "list": list, "id": item.id]) }
    public func clearDone(in list: String) { send(["type": "clearDone", "list": list]) }
    public func delete(list: String) { send(["type": "deleteList", "list": list]) }

    private func send(_ frame: [String: String]) {
        guard let data = try? JSONEncoder().encode(frame) else { return }
        try? panel?.send(json: String(decoding: data, as: UTF8.self))
    }

    override public func close() {
        panel?.disconnect()
        panel = nil
        super.close()
    }
}

private struct ListsFrame: Decodable {
    var type: String
    var lists: [NudgeList]?
    var message: String?
}

private final class ListsRelay: PanelListener, @unchecked Sendable {
    let relay: Relay<ListsState>
    // Calls come one at a time, in order, so the state can be kept here.
    private var state = ListsState()
    init(_ relay: Relay<ListsState>) { self.relay = relay }

    func onStatus(status: PanelStatus) {
        state.status = status
        relay.deliver(state)
    }

    func onFrame(json: String) {
        guard let frame = try? JSONDecoder().decode(ListsFrame.self, from: Data(json.utf8)) else { return }
        switch frame.type {
        case "lists": state.lists = frame.lists
        case "ok": state.error = nil
        case "error": state.error = frame.message
        default: return
        }
        relay.deliver(state)
    }
}

extension NudgeClient {
    /// A room's lists; the room needs the lists extension on, or the state closes with 4404.
    @MainActor
    public func observeLists(_ room: String) throws -> ObservedLists {
        let observed = ObservedLists()
        let panel = try openPanel(room: room, extension: "lists", listener: ListsRelay(Relay(observed)))
        observed.panel = panel
        observed.stop = { panel.disconnect() }
        return observed
    }
}
