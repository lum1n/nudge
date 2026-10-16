// A room's connectors (APIs the assistant may call), over the connectors extension's panel
// socket: the list as it changes, and what only people set: API keys, the local network, the
// calls that only read. A key goes to the server and never comes back; the list says only whether
// one is set.
package nudge.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.add
import nudge.ffi.NudgeClient
import nudge.ffi.Panel
import nudge.ffi.PanelListener
import nudge.ffi.PanelStatus

/** Where a connector's API key goes: a header or a query parameter named `name`. */
@Serializable
data class ConnectorAuth(
    @SerialName("in") val placement: String,
    val name: String,
    val prefix: String? = null,
)

/**
 * An API the room's assistant can call. `shared` ones are shared with every room and changed
 * only by unsharing them; `hasKey` says whether the room set an API key, never the key.
 */
@Serializable
data class Connector(
    val id: String,
    val name: String,
    val baseUrl: String,
    val useFor: String,
    val docsUrl: String? = null,
    /** What the assistant learned about using it. */
    val notes: String = "",
    val auth: ConnectorAuth? = null,
    /** May reach this machine and the local network. */
    val allowPrivateNetwork: Boolean = false,
    /** `METHOD /path` calls that only read though they aren't GET; they run without approval. */
    val readPaths: List<String> = emptyList(),
    val addedBy: String = "",
    val shared: Boolean = false,
    val hasKey: Boolean = false,
)

/**
 * What [ObservedConnectors] shows: the socket's status, the room's connectors, then the shared
 * ones, once they came; whether the player is an admin (who may share them); and the last change
 * the extension refused.
 */
data class ConnectorsState(
    val status: PanelStatus = PanelStatus.Connecting,
    val connectors: List<Connector>? = null,
    val admin: Boolean = false,
    val error: String? = null,
)

/** A room's connectors, kept current; change them with the methods here. [close] when done. */
class ObservedConnectors internal constructor() : AutoCloseable {
    internal val mutableState = MutableStateFlow(ConnectorsState())
    val state: StateFlow<ConnectorsState> = mutableState.asStateFlow()
    internal lateinit var panel: Panel

    fun setKey(connector: Connector, key: String) = send("setKey", connector) { put("value", key) }
    fun clearKey(connector: Connector) = send("clearKey", connector)
    fun allowPrivateNetwork(connector: Connector, allow: Boolean) =
        send("setPrivateNetwork", connector) { put("allow", allow) }
    fun setReadPaths(connector: Connector, readPaths: List<String>) = send("setReadPaths", connector) {
        putJsonArray("readPaths") { readPaths.forEach { add(it) } }
    }
    fun remove(connector: Connector) = send("remove", connector)
    /** For admins: every room may use it then. */
    fun share(connector: Connector) = send("share", connector)
    fun unshare(connector: Connector) = send("unshare", connector)

    private fun send(
        type: String,
        connector: Connector,
        more: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {},
    ) = panel.input(type) {
        put("connector", connector.id)
        more()
    }

    override fun close() {
        panel.disconnect()
        panel.close()
    }
}

/** A room's connectors; the room needs the connectors extension on, or the state closes with 4404. */
fun NudgeClient.observeConnectors(room: String): ObservedConnectors {
    val observed = ObservedConnectors()
    val listener = object : PanelListener {
        override fun onStatus(status: PanelStatus) {
            observed.mutableState.update { it.copy(status = status) }
        }

        override fun onFrame(json: String) {
            val frame = frameOf(json) ?: return
            when (frame.type) {
                "connectors" -> {
                    val connectors = runCatching {
                        panelJson.decodeFromJsonElement<List<Connector>>(frame["connectors"]!!)
                    }.getOrNull() ?: return
                    val admin = (frame["admin"] as? JsonPrimitive)?.booleanOrNull ?: false
                    observed.mutableState.update { it.copy(connectors = connectors, admin = admin) }
                }
                "ok" -> observed.mutableState.update { it.copy(error = null) }
                "error" -> observed.mutableState.update {
                    it.copy(error = (frame["message"] as? JsonPrimitive)?.contentOrNull)
                }
            }
        }
    }
    observed.panel = openPanel(room, "connectors", listener)
    return observed
}
