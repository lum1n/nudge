// Observable models over the bindings' listeners, for SwiftUI: each holds the latest state on the
// main actor, and the room's timeline comes whole, rebuilt from the changes on the library's
// thread. Listeners hop to the main actor in tasks, which may run out of order, so every state
// carries a number and an older one never replaces a newer one.
import Foundation
@_exported import NudgeFFI
import Observation

/// A room as an ``ObservedRoom`` shows it. `room` and `live` are nil until the first view
/// (cached or from the server); `timeline` has the earlier items, then the view's, oldest first,
/// and `pending` this client's messages the timeline doesn't show yet.
public struct RoomState: Equatable, Sendable {
    public var status: SyncStatus
    public var reason: GoneReason?
    public var error: String?
    public var room: Room?
    public var live: Live?
    public var queue: [QueuedMessage]
    public var approvals: [Approval]
    public var memory: [Fact]
    public var nudges: [RoomNudge]
    /// The members whose location the model may know in the room.
    public var sharingLocation: [Player]
    public var timeline: [TimelineItem]
    public var canLoadEarlier: Bool
    public var loadingEarlier: Bool
    public var earlierError: String?
    public var pending: [PendingMessage]

    init(_ update: RoomUpdate, timeline: [TimelineItem]) {
        status = update.status
        reason = update.reason
        error = update.error
        room = update.room
        live = update.live
        queue = update.queue
        approvals = update.approvals
        memory = update.memory
        nudges = update.nudges
        sharingLocation = update.sharingLocation
        self.timeline = timeline
        canLoadEarlier = update.canLoadEarlier
        loadingEarlier = update.loadingEarlier
        earlierError = update.earlierError
        pending = update.pending
    }
}

extension Array where Element == TimelineItem {
    /// The timeline after `changes`, applied in order.
    public func applying(_ changes: [TimelineChange]) -> [TimelineItem] {
        var items = self
        for change in changes {
            switch change {
            case .reset(let reset): items = reset
            case .append(let appended): items.append(contentsOf: appended)
            case .insert(let index, let item): items.insert(item, at: Int(index))
            case .set(let index, let item): items[Int(index)] = item
            case .remove(let index): items.remove(at: Int(index))
            }
        }
        return items
    }
}

extension TimelineItem {
    public var id: String {
        switch self {
        case .user(let id, _, _, _, _, _, _), .nudge(let id, _, _, _),
            .approval(let id, _, _, _, _, _), .answer(let id, _, _, _, _, _, _), .marker(let id, _):
            id
        }
    }
}

/// Something a client observes: its latest `value`, nil before the first. `close()` stops it;
/// so does letting go of it, which frees the subscription.
@MainActor @Observable
public class Observed<Value: Sendable> {
    public private(set) var value: Value?
    @ObservationIgnored private var number = 0
    @ObservationIgnored var stop: (@Sendable () -> Void)?

    init() {}

    public func close() {
        stop?()
        stop = nil
    }

    func set(_ value: Value, number: Int) {
        guard number > self.number else { return }
        self.number = number
        self.value = value
    }

    /// The first value, current or coming, that `predicate` accepts.
    public func first(where predicate: (Value) -> Bool) async throws -> Value {
        while true {
            if let value, predicate(value) { return value }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                withObservationTracking {
                    _ = self.value
                } onChange: {
                    continuation.resume()
                }
            }
            try Task.checkCancellation()
        }
    }
}

/// A room's ``Observed``, which can also fetch earlier items.
@MainActor
public final class ObservedRoom: Observed<RoomState> {
    @ObservationIgnored fileprivate var subscription: RoomSubscription?

    /// Fetches the page before the earliest item; the next state has it.
    public func loadEarlier(limit: UInt32? = nil) async {
        await subscription?.loadEarlier(limit: limit)
    }
}

/// Numbers what a listener hears, in the order it hears it, and hands it to the main actor.
final class Relay<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var number = 0
    private weak var observed: Observed<Value>?

    init(_ observed: Observed<Value>) {
        self.observed = observed
    }

    func deliver(_ value: Value) {
        let number = lock.withLock {
            self.number += 1
            return self.number
        }
        Task { @MainActor [weak observed] in observed?.set(value, number: number) }
    }
}

private final class ConnectionRelay: ConnectionListener {
    let relay: Relay<ConnectionStatus>
    init(_ relay: Relay<ConnectionStatus>) { self.relay = relay }
    func onStatus(status: ConnectionStatus) { relay.deliver(status) }
}

private final class RoomListRelay: RoomListListener {
    let relay: Relay<RoomListUpdate>
    init(_ relay: Relay<RoomListUpdate>) { self.relay = relay }
    func onUpdate(update: RoomListUpdate) { relay.deliver(update) }
}

private final class RoomRelay: RoomListener, @unchecked Sendable {
    let relay: Relay<RoomState>
    // Updates come one at a time, in order, so the timeline can be kept here.
    private var timeline: [TimelineItem] = []
    init(_ relay: Relay<RoomState>) { self.relay = relay }

    func onUpdate(update: RoomUpdate) {
        timeline = timeline.applying(update.timeline)
        relay.deliver(RoomState(update, timeline: timeline))
    }
}

extension NudgeClient {
    /// The socket's status, now and on every change.
    @MainActor
    public func observeConnectionState() -> Observed<ConnectionStatus> {
        let observed = Observed<ConnectionStatus>()
        let subscription = observeConnection(listener: ConnectionRelay(Relay(observed)))
        observed.stop = { subscription.cancel() }
        return observed
    }

    /// The player's room list: their rooms and nudges.
    @MainActor
    public func observeRoomListState() -> Observed<RoomListUpdate> {
        let observed = Observed<RoomListUpdate>()
        let subscription = observeRoomList(listener: RoomListRelay(Relay(observed)))
        observed.stop = { subscription.cancel() }
        return observed
    }

    /// A room's view, with its whole timeline in every state.
    @MainActor
    public func observeRoomState(_ room: String) -> ObservedRoom {
        let observed = ObservedRoom()
        let subscription = observeRoom(room: room, listener: RoomRelay(Relay(observed)))
        observed.subscription = subscription
        observed.stop = { subscription.cancel() }
        return observed
    }
}
