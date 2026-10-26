// The room's project, live, over the projects extension's panel socket: what the assistant builds
// with coding agents on the project's exe.dev VM, its milestones and tasks, and Pause and Resume.
// The extension sends the project on open and on every change; `null` when the room has none.
package nudge.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import nudge.ffi.NudgeClient
import nudge.ffi.Panel
import nudge.ffi.PanelListener
import nudge.ffi.PanelStatus

/** A task's coding-agent session, on [host]; [state] as the agent reports it. */
@Serializable
data class ProjectSession(val host: String = "", val id: String = "", val state: String? = null)

/** A task's pull request; [ci] is `pending`, `passing` or `failing`. */
@Serializable
data class ProjectPr(val url: String = "", val number: Int? = null, val ci: String? = null)

/**
 * A task of a milestone. [status] is `todo`, `running`, `review`, `done`, `blocked` or `skipped`;
 * one with a [session] has an agent at work on it.
 */
@Serializable
data class ProjectTask(
    val id: String = "",
    val title: String = "",
    val criteria: List<String> = emptyList(),
    val status: String = "todo",
    val branch: String? = null,
    val session: ProjectSession? = null,
    val pr: ProjectPr? = null,
    val note: String? = null,
)

/** A milestone; [status] is `planned`, `active`, `gate` (waiting for the person) or `merged`. */
@Serializable
data class ProjectMilestone(
    val id: String = "",
    val title: String = "",
    val status: String = "planned",
    val tasks: List<ProjectTask> = emptyList(),
)

/** The project's VM on exe.dev; [ready] once it is set up for agents. */
@Serializable
data class ProjectVm(val name: String = "", val host: String = "", val ready: Boolean = false)

/**
 * A room's project. [status] is `planning`, `running`, `paused`, `gate` or `done`; [secrets] are
 * only the names of those it has. Spend is in US dollars; [updatedAt] ms since the epoch.
 */
@Serializable
data class ProjectView(
    val id: String = "",
    val name: String = "",
    val status: String = "planning",
    val brief: String = "",
    val repo: String? = null,
    val milestones: List<ProjectMilestone> = emptyList(),
    val vm: ProjectVm? = null,
    val secrets: List<String> = emptyList(),
    val spendUsd: Double = 0.0,
    val budgetUsd: Double? = null,
    val maxAgents: Int = 0,
    val updatedAt: Double = 0.0,
) {
    /** The tasks with an agent at work on them. */
    val liveTasks: List<ProjectTask> get() = milestones.flatMap { it.tasks }.filter { it.session != null }
}

/**
 * What [ObservedProject] shows: the socket's status, whether the project came yet ([loaded]), the
 * project (null when the room has none), and the last thing the extension refused.
 */
data class ProjectState(
    val status: PanelStatus = PanelStatus.Connecting,
    val loaded: Boolean = false,
    val project: ProjectView? = null,
    val error: String? = null,
)

private val projectJson = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
}

/** The room's project, kept current; pause and resume it here. [close] when done. */
class ObservedProject internal constructor() : AutoCloseable {
    internal val mutableState = MutableStateFlow(ProjectState())
    val state: StateFlow<ProjectState> = mutableState.asStateFlow()
    internal lateinit var panel: Panel
    internal val requests = Requests()

    /** Stops starting agents; those at work finish their step. Throws [PanelRefusal] if refused. */
    suspend fun pause() {
        requests.request(panel, "pause") {}
    }

    suspend fun resume() {
        requests.request(panel, "resume") {}
    }

    internal fun receive(frame: JsonObject) {
        // An answer to Pause or Resume: a refusal is thrown where it was asked.
        if (requests.answer(frame)) return
        when (frame.type) {
            "project" -> {
                val element = frame["project"]
                val project = if (element == null || element is JsonNull) {
                    null
                } else {
                    runCatching { projectJson.decodeFromJsonElement<ProjectView>(element) }.getOrNull() ?: return
                }
                mutableState.update { it.copy(loaded = true, project = project) }
            }
            "error" -> mutableState.update { it.copy(error = (frame["message"] as? JsonPrimitive)?.contentOrNull) }
        }
    }

    override fun close() {
        panel.disconnect()
        panel.close()
    }
}

/** The room's project; the room needs the projects extension on, or the state closes with 4404. */
fun NudgeClient.observeProject(room: String): ObservedProject {
    val observed = ObservedProject()
    val listener = object : PanelListener {
        override fun onStatus(status: PanelStatus) {
            observed.requests.status(status)
            observed.mutableState.update { it.copy(status = status) }
        }

        override fun onFrame(json: String) {
            frameOf(json)?.let(observed::receive)
        }
    }
    observed.panel = openPanel(room, "projects", listener)
    return observed
}
