// What the typed panels share: inputs sent with a `ref`, and the frames that answer them.
package nudge.client

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import nudge.ffi.Panel
import nudge.ffi.PanelStatus

/** An input the extension refused, or that the socket dropped before the answer came. */
class PanelRefusal(message: String) : Exception(message)

internal val panelJson = Json { ignoreUnknownKeys = true }

/** A frame as an object, or null for one that isn't. */
internal fun frameOf(json: String): JsonObject? = runCatching { panelJson.parseToJsonElement(json).jsonObject }.getOrNull()

internal val JsonObject.type: String? get() = (this["type"] as? JsonPrimitive)?.contentOrNull

/** How long an input waits for its answer, such as a large upload on a slow network. */
private const val ANSWER_WITHIN_MS = 120_000L

/** Inputs waiting for their answer, by `ref`. */
internal class Requests {
    private val next = AtomicInteger()
    private val waiting = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()

    /** Sends an input with a fresh `ref` and waits for the frame that answers it. */
    suspend fun request(panel: Panel, type: String, more: JsonObjectBuilder.() -> Unit): JsonObject {
        val ref = "r${next.incrementAndGet()}"
        val answer = CompletableDeferred<JsonObject>()
        waiting[ref] = answer
        panel.send(
            buildJsonObject {
                put("type", type)
                put("ref", ref)
                more()
            }.toString(),
        )
        val frame = try {
            withTimeoutOrNull(ANSWER_WITHIN_MS) { answer.await() } ?: throw PanelRefusal("No answer; try again")
        } finally {
            waiting.remove(ref)
        }
        if (frame.type == "error") throw PanelRefusal((frame["message"] as? JsonPrimitive)?.contentOrNull ?: "Refused")
        return frame
    }

    /** Hands a frame to the input it answers; false for one that answers none. */
    fun answer(frame: JsonObject): Boolean {
        val ref = (frame["ref"] as? JsonPrimitive)?.contentOrNull ?: return false
        return waiting.remove(ref)?.complete(frame) != null
    }

    @Volatile private var open = false

    /**
     * The socket dropped after it was open: what waits gets no answer. While it opens, inputs
     * wait for it.
     */
    fun status(status: PanelStatus) {
        val dropped = open && status !is PanelStatus.Open
        open = status is PanelStatus.Open
        if (!dropped && status !is PanelStatus.Closed) return
        for (ref in waiting.keys.toList()) {
            waiting.remove(ref)?.completeExceptionally(PanelRefusal("The connection dropped; try again"))
        }
    }
}

/** Sends one input, as JSON, without waiting for its answer. */
internal fun Panel.input(type: String, more: JsonObjectBuilder.() -> Unit = {}) {
    send(
        buildJsonObject {
            put("type", type)
            more()
        }.toString(),
    )
}
