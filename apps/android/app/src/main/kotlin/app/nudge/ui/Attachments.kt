package app.nudge.ui

import android.content.ContentResolver
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.LruCache
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.AssistChip
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.nudge.R
import app.nudge.explain
import app.nudge.text
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nudge.client.Upload
import nudge.client.scaleForUpload
import nudge.client.sizeLabel
import nudge.ffi.Attachment
import nudge.ffi.AttachmentKind
import nudge.ffi.NudgeClient
import nudge.ffi.NudgeException
import nudge.ffi.attachmentMaxBytes
import nudge.ffi.attachmentsPerMessage

/**
 * A room's attachments as this device has fetched them: the bytes need the token, so they come
 * through the client rather than an image loader. Pictures are kept decoded, within a few
 * megabytes, so scrolling back doesn't fetch them again.
 */
class RoomAttachments(private val client: NudgeClient, private val room: String) {
    private val images = object : LruCache<String, ImageBitmap>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }

    /** The bytes of attachment `id`; null for one removed (410) or no longer to be seen (404). */
    suspend fun bytes(id: String): ByteArray? = try {
        client.attachment(room, id)
    } catch (e: NudgeException.Status) {
        if (e.status.toInt() == 410 || e.status.toInt() == 404) null else throw e
    }

    /** The picture of image `id`, decoded to at most `maxSide` pixels on its long side. */
    suspend fun image(id: String, maxSide: Int = 1024): ImageResult {
        images.get(id)?.let { return ImageResult.Shown(it) }
        val bytes = bytes(id) ?: return ImageResult.Removed
        val bitmap = withContext(Dispatchers.Default) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: return ImageResult.Unreadable
        return ImageResult.Shown(bitmap.asImageBitmap().also { images.put(id, it) })
    }

    sealed interface ImageResult {
        data class Shown(val image: ImageBitmap) : ImageResult
        data object Removed : ImageResult
        data object Unreadable : ImageResult
    }
}

/** The open room's attachments, for the timeline's rows to show. */
val LocalRoomAttachments = staticCompositionLocalOf<RoomAttachments?> { null }

/** A message's attachments: pictures for images, rows to save for other files. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AttachmentList(attachments: List<Attachment>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        attachments.forEach { attachment ->
            if (attachment.kind == AttachmentKind.IMAGE) ImageAttachment(attachment) else FileAttachment(attachment)
        }
    }
}

@Composable
private fun ImageAttachment(attachment: Attachment) {
    val store = LocalRoomAttachments.current
    val result by produceState<RoomAttachments.ImageResult?>(null, store, attachment.id) {
        value = runCatching { store?.image(attachment.id) }.getOrNull() ?: RoomAttachments.ImageResult.Unreadable
    }
    when (val shown = result) {
        is RoomAttachments.ImageResult.Shown -> Image(
            shown.image,
            contentDescription = attachment.name,
            contentScale = ContentScale.Fit,
            modifier = Modifier.widthIn(max = 260.dp).heightIn(max = 260.dp).clip(RoundedCornerShape(16.dp)),
        )
        null -> Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.size(160.dp),
        ) {}
        RoomAttachments.ImageResult.Removed -> RemovedAttachment(attachment)
        RoomAttachments.ImageResult.Unreadable -> FileAttachment(attachment)
    }
}

/** A file to save where the reader picks, through the system's document picker. */
@Composable
private fun FileAttachment(attachment: Attachment) {
    val store = LocalRoomAttachments.current
    val resolver = LocalContext.current.contentResolver
    val scope = rememberCoroutineScope()
    var note by remember { mutableStateOf<String?>(null) }
    var removed by remember { mutableStateOf(false) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(attachment.mime)) { uri ->
        if (uri == null || store == null) return@rememberLauncherForActivityResult
        scope.launch {
            note = try {
                val bytes = store.bytes(attachment.id)
                if (bytes == null) {
                    removed = true
                    null
                } else {
                    withContext(Dispatchers.IO) { resolver.openOutputStream(uri)?.use { it.write(bytes) } }
                    text(R.string.room_attachment_saved)
                }
            } catch (error: Exception) {
                explain(error)
            }
        }
    }
    if (removed) return RemovedAttachment(attachment)
    AssistChip(
        onClick = { save.launch(attachment.name) },
        label = {
            Column {
                Text("${attachment.name} · ${sizeLabel(attachment.size.toLong())}", maxLines = 2, overflow = TextOverflow.Ellipsis)
                note?.let { Text(it, style = MaterialTheme.typography.labelSmall) }
            }
        },
        leadingIcon = { Icon(Icons.Outlined.Description, stringResource(R.string.room_attachment_save, attachment.name)) },
        modifier = Modifier.widthIn(max = 300.dp),
    )
}

/** One that was removed: its name stays, so people know there was one. */
@Composable
private fun RemovedAttachment(attachment: Attachment) {
    Text(
        stringResource(R.string.room_attachment_removed, attachment.name),
        style = MaterialTheme.typography.bodySmall.copy(textDecoration = TextDecoration.LineThrough),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** What a message of files alone says in a bubble or a queue: their names. */
@Composable
fun attachmentsLabel(text: String, attachments: List<Attachment>): String =
    if (text.isEmpty() && attachments.isNotEmpty()) stringResource(R.string.room_attachments, attachments.joinToString { it.name })
    else text

/** A file picked in the composer, on its way up or ready to send. */
data class Picked(
    val key: String,
    val name: String,
    val image: Boolean,
    val uploaded: Attachment? = null,
    val error: String? = null,
)

/**
 * The composer's picked files for one room: each is read, scaled down when it is a photo, and
 * uploaded at once, so sending only names the uploads. Taking one off deletes its upload.
 */
class ComposerAttachments(private val client: NudgeClient, private val room: String) {
    var picked by mutableStateOf<List<Picked>>(emptyList())
        private set

    val uploading get() = picked.any { it.uploaded == null && it.error == null }
    val ready get() = picked.mapNotNull { it.uploaded }

    /** Reads, scales and uploads what was picked, up to what one message may carry. */
    suspend fun add(resolver: ContentResolver, uris: List<Uri>) {
        val space = attachmentsPerMessage().toInt() - picked.size
        uris.forEachIndexed { index, uri ->
            val key = UUID.randomUUID().toString()
            val mime = resolver.getType(uri) ?: "application/octet-stream"
            val name = displayName(resolver, uri) ?: uri.lastPathSegment ?: "file"
            val entry = Picked(key, name, image = mime.startsWith("image/"))
            if (index >= space) {
                picked = picked + entry.copy(error = text(R.string.room_attachment_too_many, attachmentsPerMessage().toString()))
                return@forEachIndexed
            }
            picked = picked + entry
            val outcome = try {
                val upload = withContext(Dispatchers.IO) { read(resolver, uri, name, mime) }
                if (upload == null) {
                    entry.copy(error = text(R.string.room_attachment_unreadable))
                } else if (upload.bytes.size.toULong() > attachmentMaxBytes()) {
                    entry.copy(error = text(R.string.room_attachment_too_large, sizeLabel(attachmentMaxBytes().toLong())))
                } else {
                    val attachment = client.uploadAttachment(room, upload.name, upload.mime, upload.bytes)
                    // Taken off while it was on its way: the upload goes too.
                    if (picked.none { it.key == key }) {
                        runCatching { client.removeAttachment(room, attachment.id) }
                        return@forEachIndexed
                    }
                    entry.copy(name = attachment.name, image = attachment.kind == AttachmentKind.IMAGE, uploaded = attachment)
                }
            } catch (error: Exception) {
                entry.copy(error = explain(error))
            }
            picked = picked.map { if (it.key == key) outcome else it }
        }
    }

    suspend fun remove(key: String) {
        val entry = picked.firstOrNull { it.key == key } ?: return
        picked = picked.filter { it.key != key }
        entry.uploaded?.let { runCatching { client.removeAttachment(room, it.id) } }
    }

    /** The uploads to send with a message; the composer starts empty again. */
    fun take(): List<Attachment> = ready.also { picked = emptyList() }

    private fun displayName(resolver: ContentResolver, uri: Uri): String? =
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }

    /** The file's bytes, a photo scaled down; null when it can't be read. Files too large to send aren't read whole. */
    private fun read(resolver: ContentResolver, uri: Uri, name: String, mime: String): Upload? {
        // A photo may be larger than the limit before it is scaled down; a file has to fit as it is.
        val limit = if (mime.startsWith("image/")) 64L * 1024 * 1024 else attachmentMaxBytes().toLong()
        val bytes = resolver.openInputStream(uri)?.use { it.readAtMost(limit + 1) } ?: return null
        val upload = Upload(name, mime, bytes)
        if (bytes.size > limit) return upload
        return if (mime.startsWith("image/") && mime != "image/gif") scaleForUpload(upload) else upload
    }
}

/** Up to `most` bytes of the stream: enough to tell one too large without reading it all. */
private fun java.io.InputStream.readAtMost(most: Long): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val chunk = ByteArray(64 * 1024)
    var total = 0L
    while (total < most) {
        val read = read(chunk, 0, minOf(chunk.size.toLong(), most - total).toInt())
        if (read < 0) break
        out.write(chunk, 0, read)
        total += read
    }
    return out.toByteArray()
}

/** The composer's attach button: photos through the system's photo picker, or any file. */
@Composable
fun AttachButton(pick: (List<Uri>) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val most = attachmentsPerMessage().toInt()
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(most)) { pick(it) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { pick(it) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.size(56.dp)) {
            Icon(Icons.Outlined.AttachFile, stringResource(R.string.room_attach))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.room_attach_photos)) },
                leadingIcon = { Icon(Icons.Outlined.Image, null) },
                onClick = {
                    open = false
                    photos.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.room_attach_files)) },
                leadingIcon = { Icon(Icons.Outlined.Description, null) },
                onClick = {
                    open = false
                    files.launch(arrayOf("*/*"))
                },
            )
        }
    }
}

/** The picked files as chips over the message field, and whether the model will see the images. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PickedChips(picked: List<Picked>, imagesToModel: Boolean, remove: (String) -> Unit) {
    if (picked.isEmpty()) return
    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            picked.forEach { entry ->
                InputChip(
                    selected = false,
                    onClick = { remove(entry.key) },
                    label = {
                        Column {
                            Text(entry.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val note = entry.error ?: if (entry.uploaded == null) stringResource(R.string.room_attachment_uploading) else null
                            note?.let {
                                Text(
                                    it,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (entry.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    },
                    leadingIcon = { Icon(if (entry.image) Icons.Outlined.Image else Icons.Outlined.Description, null) },
                    trailingIcon = { Icon(Icons.Outlined.Close, stringResource(R.string.room_attachment_remove, entry.name)) },
                    modifier = Modifier.widthIn(max = 260.dp),
                )
            }
        }
        if (picked.any { it.image && it.error == null }) {
            Row {
                Text(
                    stringResource(if (imagesToModel) R.string.room_images_seen else R.string.room_images_not_seen),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
