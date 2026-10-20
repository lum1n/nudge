// A room's MCP servers, over the mcp extension's panel socket: the list as it changes, and what
// only people set: keys, sign-ins, and which calls wait for approval. A key goes to the server and
// never comes back; the list says only whether one is set.
package app.nudge

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import nudge.ffi.NudgeClient
import nudge.ffi.Panel
import nudge.ffi.PanelListener
import nudge.ffi.PanelStatus

/** A key a server takes: a header or an environment variable named `name`. [set]: whether the room set it. */
data class McpKey(val placement: String, val name: String, val prefix: String?, val set: Boolean)

/**
 * An MCP server the room's assistant can use: remote at [url], or run as [command]. [runs] is the
 * one or the other as it shows; [approval] is `writes`, `always` or `never`.
 */
data class McpServer(
    val id: String,
    val name: String,
    val useFor: String,
    val runs: String,
    val url: String?,
    val command: String?,
    val keys: List<McpKey>,
    val approval: String,
    val addedBy: String,
    /** Remote servers only: whether someone signed in with OAuth. */
    val signedIn: Boolean,
    /** What went wrong the last time it was used. */
    val problem: String?,
    /** How many tools it has, once they were read. */
    val tools: Int?,
)

/** What [ObservedMcpServers] shows: the socket's status, the room's servers once they came, and the last change refused. */
data class McpServersState(
    val status: PanelStatus = PanelStatus.Connecting,
    val servers: List<McpServer>? = null,
    val error: String? = null,
)

/** How long a sign-in waits for the address to open. */
private const val SIGN_IN_WITHIN_MS = 60_000L

/** A room's MCP servers, kept current; change them with the methods here. [close] when done. */
class ObservedMcpServers internal constructor() : AutoCloseable {
    internal val mutableState = MutableStateFlow(McpServersState())
    val state: StateFlow<McpServersState> = mutableState.asStateFlow()
    internal lateinit var panel: Panel
    private val next = AtomicInteger()
    internal val signIns = ConcurrentHashMap<String, CompletableDeferred<String?>>()

    fun setKey(server: McpServer, key: McpKey, value: String) = send("setKey", server) {
        put("key", key.name)
        put("value", value)
    }
    fun clearKey(server: McpServer, key: McpKey) = send("clearKey", server) { put("key", key.name) }
    fun setApproval(server: McpServer, approval: String) = send("setApproval", server) { put("approval", approval) }
    fun signOut(server: McpServer) = send("signOut", server)
    fun refresh(server: McpServer) = send("refresh", server)
    fun remove(server: McpServer) = send("remove", server)

    /**
     * The address to sign in at, in the browser; null when the extension refused (see the state's
     * error) or no answer came. [base] is the address the app reaches the server by: the sign-in
     * comes back there.
     */
    suspend fun signIn(server: McpServer, base: String): String? {
        val ref = "s${next.incrementAndGet()}"
        val answer = CompletableDeferred<String?>()
        signIns[ref] = answer
        return try {
            send("signIn", server) {
                put("ref", ref)
                put("base", base)
            }
            withTimeoutOrNull(SIGN_IN_WITHIN_MS) { answer.await() }
        } finally {
            signIns.remove(ref)
        }
    }

    private fun send(type: String, server: McpServer, more: JsonObjectBuilder.() -> Unit = {}) = panel.send(
        buildJsonObject {
            put("type", type)
            put("server", server.id)
            more()
        }.toString(),
    )

    override fun close() {
        panel.disconnect()
        panel.close()
    }
}

private fun JsonObject.string(name: String) = (this[name] as? JsonPrimitive)?.contentOrNull

private fun serverOf(json: JsonObject): McpServer? {
    val keys = (json["keys"] as? JsonArray).orEmpty().mapNotNull { element ->
        val key = element as? JsonObject ?: return@mapNotNull null
        McpKey(
            placement = key.string("in") ?: return@mapNotNull null,
            name = key.string("name") ?: return@mapNotNull null,
            prefix = key.string("prefix"),
            set = (key["set"] as? JsonPrimitive)?.booleanOrNull ?: false,
        )
    }
    return McpServer(
        id = json.string("id") ?: return null,
        name = json.string("name") ?: return null,
        useFor = json.string("useFor").orEmpty(),
        runs = json.string("runs").orEmpty(),
        url = json.string("url"),
        command = json.string("command"),
        keys = keys,
        approval = json.string("approval") ?: "writes",
        addedBy = json.string("addedBy").orEmpty(),
        signedIn = (json["signedIn"] as? JsonPrimitive)?.booleanOrNull ?: false,
        problem = json.string("problem"),
        tools = (json["tools"] as? JsonPrimitive)?.intOrNull,
    )
}

/** A room's MCP servers; the room needs the mcp extension on, or the state closes with 4404. */
fun NudgeClient.observeMcpServers(room: String): ObservedMcpServers {
    val observed = ObservedMcpServers()
    val listener = object : PanelListener {
        override fun onStatus(status: PanelStatus) {
            observed.mutableState.update { it.copy(status = status) }
            // No answer comes over a closed socket.
            if (status is PanelStatus.Closed) observed.signIns.values.forEach { it.complete(null) }
        }

        override fun onFrame(json: String) {
            val frame = runCatching { Json.parseToJsonElement(json).jsonObject }.getOrNull() ?: return
            val ref = frame.string("ref")
            when (frame.string("type")) {
                "servers" -> {
                    val servers = (frame["servers"] as? JsonArray ?: return).mapNotNull { (it as? JsonObject)?.let(::serverOf) }
                    observed.mutableState.update { it.copy(servers = servers) }
                }
                "signIn" -> {
                    observed.mutableState.update { it.copy(error = null) }
                    ref?.let { observed.signIns[it]?.complete(frame.string("url")) }
                }
                "ok" -> observed.mutableState.update { it.copy(error = null) }
                "error" -> {
                    observed.mutableState.update { it.copy(error = frame.string("message")) }
                    ref?.let { observed.signIns[it]?.complete(null) }
                }
            }
        }
    }
    observed.panel = openPanel(room, "mcp", listener)
    return observed
}
