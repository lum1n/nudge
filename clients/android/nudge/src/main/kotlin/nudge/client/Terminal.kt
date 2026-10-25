// The room's terminal, live, over the terminal extension's panel socket: the commands the
// assistant ran in the room's sandboxed workspace, their output as it comes, and those that wait
// for approval. It is only watched; approve and deny with `NudgeClient.decide`.
package nudge.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import nudge.ffi.NudgeClient
import nudge.ffi.Panel
import nudge.ffi.PanelListener
import nudge.ffi.PanelStatus

/**
 * A command of the room's terminal. `status` is `waiting` (for [approval]), `running`, `done`,
 * `failed`, `stopped` (why in [ending]) or `denied`; `decidedBy` is who approved or denied it.
 * `output` is stdout and stderr together, only its end when long. Times are ms since the epoch.
 */
@Serializable
data class TerminalCommand(
    val id: String,
    val command: String,
    val cwd: String? = null,
    val status: String,
    val approval: String? = null,
    val decidedBy: String? = null,
    val output: String = "",
    val exitCode: Int? = null,
    val ending: String? = null,
    val startedAt: Double,
    val endedAt: Double? = null,
)

/** What [ObservedTerminal] shows: the socket's status, the commands once they came, oldest first. */
data class TerminalState(
    val status: PanelStatus = PanelStatus.Connecting,
    val commands: List<TerminalCommand>? = null,
    val error: String? = null,
)

/** The room's terminal, kept current. [close] when done. */
class ObservedTerminal internal constructor() : AutoCloseable {
    internal val mutableState = MutableStateFlow(TerminalState())
    val state: StateFlow<TerminalState> = mutableState.asStateFlow()
    internal lateinit var panel: Panel

    internal fun receive(frame: JsonObject) {
        val text = { key: String -> (frame[key] as? JsonPrimitive)?.contentOrNull }
        when (frame.type) {
            "commands" -> mutableState.update {
                val commands = runCatching {
                    panelJson.decodeFromJsonElement<List<TerminalCommand>>(frame["commands"]!!)
                }.getOrNull() ?: return
                it.copy(commands = commands, error = null)
            }
            // Output while a command runs, after what the last `commands` frame had of it.
            "output" -> mutableState.update {
                val id = text("id") ?: return
                val chunk = text("chunk") ?: return
                it.copy(commands = it.commands?.map { command -> if (command.id == id) command.copy(output = command.output + chunk) else command })
            }
            "error" -> mutableState.update { it.copy(error = text("message")) }
        }
    }

    override fun close() {
        panel.disconnect()
        panel.close()
    }
}

/** The room's terminal; the room needs the terminal extension on, or the state closes with 4404. */
fun NudgeClient.observeTerminal(room: String): ObservedTerminal {
    val observed = ObservedTerminal()
    val listener = object : PanelListener {
        override fun onStatus(status: PanelStatus) {
            observed.mutableState.update { it.copy(status = status) }
        }

        override fun onFrame(json: String) {
            frameOf(json)?.let(observed::receive)
        }
    }
    observed.panel = openPanel(room, "terminal", listener)
    return observed
}
