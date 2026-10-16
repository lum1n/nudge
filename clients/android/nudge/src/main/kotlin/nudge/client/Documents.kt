// A room's documents, over the documents extension's panel socket: the list as it changes,
// uploads, downloads and deletions. Files cross the socket as base64. The socket reconnects on its
// own and the extension sends the list again each time.
package nudge.client

import java.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import nudge.ffi.NudgeClient
import nudge.ffi.Panel
import nudge.ffi.PanelListener
import nudge.ffi.PanelStatus

/**
 * A document in a room: `size` in bytes, `chars` of text read from it, `pages` for a PDF, `note`
 * when its text couldn't be read (such as an image). `addedAt` is ms since the epoch.
 */
@Serializable
data class DocumentInfo(
    val id: String,
    val name: String,
    val mime: String,
    val size: Long,
    val pages: Int? = null,
    val chars: Int = 0,
    val note: String? = null,
    val addedBy: String,
    val addedAt: Double,
)

/** A downloaded document's bytes. */
class DocumentFile(val name: String, val mime: String, val bytes: ByteArray)

/**
 * What [ObservedDocuments] shows: the socket's status, the documents (newest first) once they
 * came, and the last deletion the extension refused.
 */
data class DocumentsState(
    val status: PanelStatus = PanelStatus.Connecting,
    val documents: List<DocumentInfo>? = null,
    val error: String? = null,
)

/** A room's documents, kept current; change them with the methods here. [close] when done. */
class ObservedDocuments internal constructor() : AutoCloseable {
    internal val mutableState = MutableStateFlow(DocumentsState())
    val state: StateFlow<DocumentsState> = mutableState.asStateFlow()
    internal lateinit var panel: Panel
    internal val requests = Requests()

    /**
     * Uploads a file; its text is read on the host. Returns the new document's id, or throws
     * [PanelRefusal], such as for a file that is too large or here already.
     */
    suspend fun upload(name: String, mime: String, bytes: ByteArray): String {
        val data = Base64.getEncoder().encodeToString(bytes)
        val answer = requests.request(panel, "upload") {
            put("name", name)
            put("mime", mime)
            put("data", data)
        }
        return (answer["id"] as? JsonPrimitive)?.contentOrNull ?: ""
    }

    /** The document's file, as it was uploaded; throws [PanelRefusal]. */
    suspend fun download(document: DocumentInfo): DocumentFile {
        val answer = requests.request(panel, "download") { put("id", document.id) }
        val text = { key: String -> (answer[key] as? JsonPrimitive)?.contentOrNull ?: "" }
        return DocumentFile(text("name"), text("mime"), Base64.getDecoder().decode(text("data")))
    }

    fun remove(document: DocumentInfo) = panel.input("remove") { put("id", document.id) }

    override fun close() {
        panel.disconnect()
        panel.close()
    }
}

/** A room's documents; the room needs the documents extension on, or the state closes with 4404. */
fun NudgeClient.observeDocuments(room: String): ObservedDocuments {
    val observed = ObservedDocuments()
    val listener = object : PanelListener {
        override fun onStatus(status: PanelStatus) {
            observed.requests.status(status)
            observed.mutableState.update { it.copy(status = status) }
        }

        override fun onFrame(json: String) {
            val frame = frameOf(json) ?: return
            if (observed.requests.answer(frame)) return
            when (frame.type) {
                "documents" -> {
                    val documents = runCatching {
                        panelJson.decodeFromJsonElement<List<DocumentInfo>>(frame["documents"]!!)
                    }.getOrNull() ?: return
                    observed.mutableState.update { it.copy(documents = documents) }
                }
                "ok" -> observed.mutableState.update { it.copy(error = null) }
                "error" -> observed.mutableState.update {
                    it.copy(error = (frame["message"] as? JsonPrimitive)?.contentOrNull)
                }
            }
        }
    }
    observed.panel = openPanel(room, "documents", listener)
    return observed
}
