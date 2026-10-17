// StateFlows over the bindings' listeners, for view models and Compose: the room's timeline
// comes whole in every state, rebuilt from the changes on the library's thread.
package nudge.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import nudge.ffi.Approval
import nudge.ffi.ConnectionListener
import nudge.ffi.ConnectionStatus
import nudge.ffi.Fact
import nudge.ffi.GoneReason
import nudge.ffi.Live
import nudge.ffi.NudgeClient
import nudge.ffi.PendingMessage
import nudge.ffi.QueuedMessage
import nudge.ffi.Room
import nudge.ffi.RoomListListener
import nudge.ffi.RoomListUpdate
import nudge.ffi.RoomListener
import nudge.ffi.RoomNudge
import nudge.ffi.RoomSubscription
import nudge.ffi.RoomUpdate
import nudge.ffi.Subscription
import nudge.ffi.SyncStatus
import nudge.ffi.TimelineChange
import nudge.ffi.TimelineItem

/**
 * A room as an [ObservedRoom] shows it. `room` and `live` are null until the first view (cached
 * or from the server); `timeline` has the earlier items, then the view's, oldest first, and
 * `pending` this client's messages the timeline doesn't show yet.
 */
data class RoomState(
    val status: SyncStatus,
    val reason: GoneReason?,
    val error: String?,
    val room: Room?,
    val live: Live?,
    val queue: List<QueuedMessage>,
    val approvals: List<Approval>,
    val memory: List<Fact>,
    val nudges: List<RoomNudge>,
    val timeline: List<TimelineItem>,
    val canLoadEarlier: Boolean,
    val loadingEarlier: Boolean,
    val earlierError: String?,
    val pending: List<PendingMessage>,
)

/** The timeline after [changes], applied in order. */
fun List<TimelineItem>.applying(changes: List<TimelineChange>): List<TimelineItem> {
    val items = toMutableList()
    for (change in changes) {
        when (change) {
            is TimelineChange.Reset -> {
                items.clear()
                items.addAll(change.items)
            }
            is TimelineChange.Append -> items.addAll(change.items)
            is TimelineChange.Insert -> items.add(change.index.toInt(), change.item)
            is TimelineChange.Set -> items[change.index.toInt()] = change.item
            is TimelineChange.Remove -> items.removeAt(change.index.toInt())
        }
    }
    return items
}

/** Something a client observes: its latest [state], null before the first. [close] stops it. */
open class Observed<T : Any> internal constructor() : AutoCloseable {
    internal val mutableState = MutableStateFlow<T?>(null)
    val state: StateFlow<T?> = mutableState.asStateFlow()
    internal lateinit var subscription: AutoCloseable

    override fun close() {
        subscription.close()
    }
}

/** A room's [Observed], which can also fetch earlier items. */
class ObservedRoom internal constructor() : Observed<RoomState>() {
    internal lateinit var room: RoomSubscription

    /** Fetches the page before the earliest item; the next state has it. */
    suspend fun loadEarlier(limit: UInt? = null) {
        room.loadEarlier(limit)
    }
}

/** The socket's status, now and on every change. */
fun NudgeClient.observeConnectionState(): Observed<ConnectionStatus> {
    val observed = Observed<ConnectionStatus>()
    val listener = object : ConnectionListener {
        override fun onStatus(status: ConnectionStatus) {
            observed.mutableState.value = status
        }
    }
    observed.subscription = closing(observeConnection(listener))
    return observed
}

/** The player's room list: their rooms and nudges. */
fun NudgeClient.observeRoomListState(): Observed<RoomListUpdate> {
    val observed = Observed<RoomListUpdate>()
    val listener = object : RoomListListener {
        override fun onUpdate(update: RoomListUpdate) {
            observed.mutableState.value = update
        }
    }
    observed.subscription = closing(observeRoomList(listener))
    return observed
}

/** A room's view, with its whole timeline in every state. */
fun NudgeClient.observeRoomState(room: String): ObservedRoom {
    val observed = ObservedRoom()
    val listener = object : RoomListener {
        // Updates come one at a time, in order, so the timeline can be kept here.
        private var timeline: List<TimelineItem> = emptyList()

        override fun onUpdate(update: RoomUpdate) {
            timeline = timeline.applying(update.timeline)
            observed.mutableState.value = update.toState(timeline)
        }
    }
    val subscription = observeRoom(room, listener)
    observed.room = subscription
    observed.subscription = AutoCloseable {
        subscription.cancel()
        subscription.close()
    }
    return observed
}

private fun closing(subscription: Subscription) = AutoCloseable {
    subscription.cancel()
    subscription.close()
}

private fun RoomUpdate.toState(timeline: List<TimelineItem>) = RoomState(
    status = status,
    reason = reason,
    error = error,
    room = room,
    live = live,
    queue = queue,
    approvals = approvals,
    memory = memory,
    nudges = nudges,
    timeline = timeline,
    canLoadEarlier = canLoadEarlier,
    loadingEarlier = loadingEarlier,
    earlierError = earlierError,
    pending = pending,
)
