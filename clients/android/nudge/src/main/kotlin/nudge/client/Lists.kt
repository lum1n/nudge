// A room's shared lists, over the lists extension's panel socket: the lists as they change, and
// the edits a member can make. The socket reconnects on its own and the extension sends the
// lists again each time.
package nudge.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nudge.ffi.NudgeClient
import nudge.ffi.Panel
import nudge.ffi.PanelListener
import nudge.ffi.PanelStatus

/** An item on a list; `by` is the display name of whoever added it, `at` ms since the epoch. */
@Serializable
data class ListItem(val id: String, val text: String, val done: Boolean, val by: String, val at: Double)

/** One of a room's lists; names are unique in a room, and lower case. */
@Serializable
data class NudgeList(val name: String, val items: List<ListItem>)

/**
 * What [ObservedLists] shows: the socket's status, the lists once they came, and the last edit
 * the extension refused.
 */
data class ListsState(
    val status: PanelStatus = PanelStatus.Connecting,
    val lists: List<NudgeList>? = null,
    val error: String? = null,
)

/** A room's lists, kept current; edit them with the methods here. [close] when done. */
class ObservedLists internal constructor() : AutoCloseable {
    internal val mutableState = MutableStateFlow(ListsState())
    val state: StateFlow<ListsState> = mutableState.asStateFlow()
    internal lateinit var panel: Panel

    fun add(text: String, list: String) = send("add", list) { put("text", text) }
    fun toggle(item: ListItem, list: String) = send("toggle", list) { put("id", item.id) }
    fun remove(item: ListItem, list: String) = send("remove", list) { put("id", item.id) }
    fun clearDone(list: String) = send("clearDone", list)
    fun delete(list: String) = send("deleteList", list)

    private fun send(
        type: String,
        list: String,
        more: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {},
    ) {
        val frame = buildJsonObject {
            put("type", type)
            put("list", list)
            more()
        }
        panel.send(frame.toString())
    }

    override fun close() {
        panel.disconnect()
        panel.close()
    }
}

@Serializable
private data class ListsFrame(
    val type: String,
    val lists: List<NudgeList>? = null,
    val message: String? = null,
)

private val json = Json { ignoreUnknownKeys = true }

/** A room's lists; the room needs the lists extension on, or the state closes with 4404. */
fun NudgeClient.observeLists(room: String): ObservedLists {
    val observed = ObservedLists()
    val listener = object : PanelListener {
        override fun onStatus(status: PanelStatus) {
            observed.mutableState.update { it.copy(status = status) }
        }

        override fun onFrame(json: String) {
            val frame = runCatching { nudge.client.json.decodeFromString<ListsFrame>(json) }.getOrNull()
                ?: return
            when (frame.type) {
                "lists" -> observed.mutableState.update { it.copy(lists = frame.lists) }
                "ok" -> observed.mutableState.update { it.copy(error = null) }
                "error" -> observed.mutableState.update { it.copy(error = frame.message) }
            }
        }
    }
    observed.panel = openPanel(room, "lists", listener)
    return observed
}
