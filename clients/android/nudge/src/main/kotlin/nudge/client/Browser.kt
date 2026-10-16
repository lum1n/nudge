// The room's browser, live, over the browser extension's panel socket: JPEG frames of its tab,
// and taps, scrolls and typing sent back. One viewer at a time drives it; the others watch until
// they take control. What is typed here goes to the browser only, and `done` can save a login
// typed here so the assistant logs in by itself next time. Nothing of it goes to a model.
package nudge.client

import java.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import nudge.ffi.NudgeClient
import nudge.ffi.Panel
import nudge.ffi.PanelListener
import nudge.ffi.PanelStatus
import nudge.ffi.ToolPart

/** A frame of the browser's tab: a JPEG of `width` by `height` page pixels, and its address. */
class BrowserFrame(val jpeg: ByteArray, val width: Int, val height: Int, val url: String)

/** A login the browser keeps for the room; its password never leaves the server. */
@Serializable
data class SavedLogin(val host: String, val username: String? = null, val savedAt: Double)

/** Who drives the browser (`holder`, a display name), and whether it is this viewer. */
data class BrowserControl(val holder: String?, val you: Boolean)

/**
 * What [ObservedBrowser] shows: the socket's status, the latest frame, who is in control, the
 * hosts whose logins the last `done` saved, the saved logins, and the last error.
 */
data class BrowserState(
    val status: PanelStatus = PanelStatus.Connecting,
    val frame: BrowserFrame? = null,
    val control: BrowserControl? = null,
    val saved: List<String>? = null,
    val logins: List<SavedLogin>? = null,
    val error: String? = null,
)

/**
 * The room's browser, kept current; drive it with the methods here, while in control.
 * Coordinates are page pixels, as in [BrowserFrame]. [close] when done.
 */
class ObservedBrowser internal constructor() : AutoCloseable {
    internal val mutableState = MutableStateFlow(BrowserState())
    val state: StateFlow<BrowserState> = mutableState.asStateFlow()
    internal lateinit var panel: Panel

    /** `button` is `left`, `right` or `middle`. */
    fun click(x: Int, y: Int, button: String = "left", double: Boolean = false) = panel.input("click") {
        put("x", x)
        put("y", y)
        put("button", button)
        if (double) put("double", true)
    }

    fun scroll(x: Int, y: Int, dx: Double, dy: Double) = panel.input("wheel") {
        put("x", x)
        put("y", y)
        put("dx", dx)
        put("dy", dy)
    }

    /** Types text into the page, as if on a keyboard. */
    fun type(text: String) = panel.input("text") { put("text", text) }

    /** Presses a key by its name, such as `Enter`, `Backspace`, `Tab` or `Control+A`. */
    fun press(key: String) = panel.input("key") { put("key", key) }

    fun navigate(url: String) = panel.input("navigate") { put("url", url) }
    fun back() = navigate("back")

    /** Finished, such as logging in; with [remember], a login typed here is saved for the room. */
    fun done(remember: Boolean) = panel.input("done") { put("remember", remember) }

    /** Takes control from whoever has it. */
    fun takeControl() = panel.input("take")

    fun forget(login: SavedLogin) = panel.input("forget") { put("host", login.host) }

    override fun close() {
        panel.disconnect()
        panel.close()
    }
}

/** The room's browser; the room needs the browser extension on, or the state closes with 4404. */
fun NudgeClient.observeBrowser(room: String): ObservedBrowser {
    val observed = ObservedBrowser()
    val listener = object : PanelListener {
        override fun onStatus(status: PanelStatus) {
            observed.mutableState.update { it.copy(status = status) }
        }

        override fun onFrame(json: String) {
            val frame = frameOf(json) ?: return
            val text = { key: String -> (frame[key] as? JsonPrimitive)?.contentOrNull }
            val number = { key: String -> (frame[key] as? JsonPrimitive)?.doubleOrNull?.toInt() ?: 0 }
            when (frame.type) {
                "frame" -> {
                    val jpeg = runCatching { Base64.getDecoder().decode(text("data") ?: "") }.getOrNull() ?: return
                    val shown = BrowserFrame(jpeg, number("width"), number("height"), text("url") ?: "")
                    // A new page: the last error was about the one before.
                    observed.mutableState.update {
                        it.copy(frame = shown, error = if (it.frame?.url == shown.url) it.error else null)
                    }
                }
                "control" -> observed.mutableState.update {
                    val you = (frame["you"] as? JsonPrimitive)?.booleanOrNull ?: false
                    it.copy(control = BrowserControl(text("holder"), you), error = null)
                }
                "done" -> observed.mutableState.update {
                    it.copy(saved = runCatching { panelJson.decodeFromJsonElement<List<String>>(frame["saved"]!!) }.getOrNull())
                }
                "logins" -> observed.mutableState.update {
                    it.copy(logins = runCatching { panelJson.decodeFromJsonElement<List<SavedLogin>>(frame["logins"]!!) }.getOrNull())
                }
                "error" -> observed.mutableState.update { it.copy(error = text("message")) }
            }
        }
    }
    observed.panel = openPanel(room, "browser", listener)
    return observed
}

/** Whether a tool call is the browser stopping for a login the user has to type in the live view. */
val ToolPart.needsLogin: Boolean
    get() {
        if (name != "browse") return false
        val details = detailsJson ?: return false
        val parsed = runCatching { panelJson.parseToJsonElement(details).jsonObject }.getOrNull() ?: return false
        return (parsed["needsLogin"] as? JsonPrimitive)?.booleanOrNull == true
    }
