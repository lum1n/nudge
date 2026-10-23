// The room's desktop, live, over the desktop extension's panel socket: PNGs of the parts of its
// screen that changed, its windows and apps, and taps, drags, scrolls and typing sent back. One
// viewer at a time drives it; the others watch until they take control. Nothing of it goes to a
// model: the desktop agent reads the apps' accessibility trees, not this.
package nudge.client

import java.util.Base64
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import nudge.ffi.NudgeClient
import nudge.ffi.Panel
import nudge.ffi.PanelListener
import nudge.ffi.PanelStatus

/**
 * A part of the desktop's screen that changed: a PNG of `width` by `height` screen pixels, to draw
 * at `x`, `y` over what was there, on a screen of `screenWidth` by `screenHeight`.
 */
class DesktopPatch(
    val png: ByteArray,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val screenWidth: Int,
    val screenHeight: Int,
)

/** A window on the desktop: [ObservedDesktop.raise] brings it to the front. */
@Serializable
data class DesktopWindow(val ref: String, val title: String = "", val app: String = "")

/** Who drives the desktop (`holder`, a display name), and whether it is this viewer. */
data class DesktopControl(val holder: String?, val you: Boolean)

/**
 * What [ObservedDesktop] shows besides the screen: the socket's status, the screen's size once
 * known, the windows, the apps it can start, what the assistant is doing there now, who is in
 * control, and the last error.
 */
data class DesktopState(
    val status: PanelStatus = PanelStatus.Connecting,
    val screenWidth: Int = 0,
    val screenHeight: Int = 0,
    val windows: List<DesktopWindow> = emptyList(),
    val apps: List<String> = emptyList(),
    val working: String? = null,
    val control: DesktopControl? = null,
    val error: String? = null,
)

/**
 * The room's desktop, kept current; drive it with the methods here, while in control.
 * Coordinates are screen pixels, as in [DesktopPatch]. [close] when done.
 */
class ObservedDesktop internal constructor() : AutoCloseable {
    internal val mutableState = MutableStateFlow(DesktopState())
    val state: StateFlow<DesktopState> = mutableState.asStateFlow()
    private val changes = Channel<DesktopPatch>(Channel.UNLIMITED)

    /**
     * What changed on the screen, in order, for one reader to draw each over the last. The first
     * after connecting is the whole screen.
     */
    val patches: ReceiveChannel<DesktopPatch> get() = changes
    internal lateinit var panel: Panel

    /** `button` is `left`, `right` or `middle`. */
    fun click(x: Int, y: Int, button: String = "left", double: Boolean = false) = panel.input("click") {
        put("x", x)
        put("y", y)
        put("button", button)
        if (double) put("double", true)
    }

    /** Presses the left button at one point and lets go at another: selecting text, moving things. */
    fun drag(fromX: Int, fromY: Int, toX: Int, toY: Int) = panel.input("drag") {
        putJsonObject("from") {
            put("x", fromX)
            put("y", fromY)
        }
        putJsonObject("to") {
            put("x", toX)
            put("y", toY)
        }
    }

    /** Scrolls at a point; about 100 is one notch of a mouse wheel. */
    fun scroll(x: Int, y: Int, dx: Double, dy: Double) = panel.input("wheel") {
        put("x", x)
        put("y", y)
        put("dx", dx)
        put("dy", dy)
    }

    /** Types text into the window under the pointer, as if on a keyboard. */
    fun type(text: String) = panel.input("text") { put("text", text) }

    /** Presses a key or combo, such as `Enter`, `Backspace`, `F2` or `ctrl+s`. */
    fun press(keys: String) = panel.input("key") { put("key", keys) }

    /** Starts one of [DesktopState.apps]. */
    fun launch(app: String) = panel.input("launch") { put("app", app) }

    /** Brings a window to the front: the desktop has no window manager to click. */
    fun raise(window: DesktopWindow) = panel.input("raise") { put("ref", window.ref) }

    /** Takes control from whoever has it. */
    fun takeControl() = panel.input("take")

    internal fun receive(frame: JsonObject) {
        val text = { key: String -> (frame[key] as? JsonPrimitive)?.contentOrNull }
        val number = { from: JsonObject, key: String -> (from[key] as? JsonPrimitive)?.doubleOrNull?.toInt() ?: 0 }
        when (frame.type) {
            "frame" -> {
                val png = runCatching { Base64.getDecoder().decode(text("data") ?: "") }.getOrNull() ?: return
                val screen = frame["screen"] as? JsonObject ?: return
                val patch = DesktopPatch(
                    png, number(frame, "x"), number(frame, "y"), number(frame, "width"), number(frame, "height"),
                    number(screen, "width"), number(screen, "height"),
                )
                mutableState.update { it.copy(screenWidth = patch.screenWidth, screenHeight = patch.screenHeight) }
                changes.trySend(patch)
            }
            "windows" -> mutableState.update {
                it.copy(windows = runCatching { panelJson.decodeFromJsonElement<List<DesktopWindow>>(frame["windows"]!!) }.getOrDefault(it.windows))
            }
            "apps" -> mutableState.update {
                it.copy(apps = runCatching { panelJson.decodeFromJsonElement<List<String>>(frame["apps"]!!) }.getOrDefault(it.apps))
            }
            // The agent's step, as it starts it; empty once it is done.
            "status" -> mutableState.update { it.copy(working = text("text")?.takeIf(String::isNotEmpty)) }
            "control" -> mutableState.update {
                val you = (frame["you"] as? JsonPrimitive)?.booleanOrNull ?: false
                it.copy(control = DesktopControl(text("holder"), you), error = null)
            }
            "error" -> mutableState.update { it.copy(error = text("message")) }
        }
    }

    override fun close() {
        changes.close()
        panel.disconnect()
        panel.close()
    }
}

/** The room's desktop; the room needs the desktop extension on, or the state closes with 4404. */
fun NudgeClient.observeDesktop(room: String): ObservedDesktop {
    val observed = ObservedDesktop()
    val listener = object : PanelListener {
        override fun onStatus(status: PanelStatus) {
            observed.mutableState.update { it.copy(status = status) }
        }

        override fun onFrame(json: String) {
            frameOf(json)?.let(observed::receive)
        }
    }
    observed.panel = openPanel(room, "desktop", listener)
    return observed
}
