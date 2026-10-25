package app.nudge.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.text.format.Formatter
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.R
import app.nudge.text
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nudge.client.DocumentFile
import nudge.client.DocumentInfo
import nudge.client.DocumentsState
import nudge.client.ObservedDocuments
import nudge.client.observeDocuments
import nudge.ffi.NudgeClient
import nudge.ffi.PanelStatus

/**
 * The room's documents: receipts, warranties, contracts and letters. Their text is read on the
 * host, so the assistant can search them; the files are stored encrypted there.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun DocumentsScreen(client: NudgeClient, roomId: String, close: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val observed = remember(client, roomId) { MutableStateFlow<ObservedDocuments?>(null) }
    DisposableEffect(client, roomId) {
        val documents = client.observeDocuments(roomId)
        observed.value = documents
        onDispose { documents.close() }
    }
    val documents by observed.collectAsStateWithLifecycle()
    val state = documents?.state?.collectAsStateWithLifecycle()?.value ?: DocumentsState()
    var uploading by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf<DocumentFile?>(null) }
    var deleting by remember { mutableStateOf<DocumentInfo?>(null) }

    // Saving a download goes through the system's file picker, so no storage permission.
    val createFile = remember {
        object : ActivityResultContracts.CreateDocument("*/*") {
            // The document's own type, so the picker keeps its name as it is.
            override fun createIntent(context: Context, input: String) =
                super.createIntent(context, input).setType(saving?.mime?.takeIf { it.contains('/') } ?: "*/*")
        }
    }
    val save = rememberLauncherForActivityResult(createFile) { uri ->
        val file = saving
        saving = null
        if (uri == null || file == null) return@rememberLauncherForActivityResult
        scope.launch {
            problem = runCatching {
                withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(file.bytes) } }
            }.exceptionOrNull()?.let { text(R.string.room_documents_couldnt_save, file.name, "${it.message}") }
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val panel = documents ?: return@rememberLauncherForActivityResult
        scope.launch {
            for (uri in uris) {
                val (name, mime) = describe(context, uri)
                uploading = name
                problem = try {
                    val bytes = withContext(Dispatchers.IO) {
                        context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    } ?: error(text(R.string.room_documents_couldnt_read, name))
                    panel.upload(name, mime, bytes)
                    null
                } catch (error: Exception) {
                    error.message
                }
            }
            uploading = null
        }
    }

    fun download(document: DocumentInfo) {
        val panel = documents ?: return
        scope.launch {
            try {
                saving = panel.download(document)
                save.launch(document.name)
            } catch (error: Exception) {
                problem = error.message
            }
        }
    }

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(stringResource(R.string.room_documents_title)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, stringResource(R.string.room_close)) } },
            )
        },
        floatingActionButton = {
            if (state.documents != null) {
                ExtendedFloatingActionButton(
                    onClick = { if (uploading == null) pick.launch(arrayOf("*/*")) },
                    icon = {
                        if (uploading == null) Icon(Icons.Outlined.UploadFile, null) else LoadingIndicator(Modifier.size(24.dp))
                    },
                    text = { Text(uploading?.let { stringResource(R.string.room_documents_uploading, it) } ?: stringResource(R.string.room_documents_upload)) },
                )
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            val status = state.status
            val all = state.documents
            when {
                status is PanelStatus.Closed && status.code.toInt() == 4404 -> Text(
                    stringResource(R.string.room_documents_off),
                    Modifier.align(Alignment.Center).padding(32.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                all == null -> LoadingIndicator(Modifier.align(Alignment.Center))
                else -> DocumentList(all, problem ?: state.error, download = ::download, delete = { deleting = it })
            }
        }
    }

    deleting?.let { document ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            icon = { Icon(Icons.Outlined.Delete, null) },
            title = { Text(stringResource(R.string.room_documents_delete_title, document.name)) },
            text = { Text(stringResource(R.string.room_documents_delete_body)) },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    documents?.remove(document)
                }) { Text(stringResource(R.string.room_delete)) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text(stringResource(R.string.room_cancel)) } },
        )
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun DocumentList(
    all: List<DocumentInfo>,
    error: String?,
    download: (DocumentInfo) -> Unit,
    delete: (DocumentInfo) -> Unit,
) {
    val context = LocalContext.current
    var query by remember { mutableStateOf("") }
    val words = query.lowercase().split(' ').filter { it.isNotBlank() }
    val shown = all.filter { document ->
        words.all { word -> document.name.lowercase().contains(word) || document.addedBy.lowercase().contains(word) }
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 96.dp),
    ) {
        item {
            Text(
                stringResource(R.string.room_documents_about),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }
        if (all.size > 3) {
            item {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text(stringResource(R.string.room_documents_find)) },
                    leadingIcon = { Icon(Icons.Outlined.Search, null) },
                    singleLine = true,
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                )
            }
        }
        if (all.isEmpty()) {
            item {
                Text(
                    stringResource(R.string.room_documents_none),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(ListItemDefaults.SegmentedGap)) {
                shown.forEachIndexed { index, document ->
                    SegmentedListItem(
                        onClick = { download(document) },
                        shapes = ListItemDefaults.segmentedShapes(index = index, count = shown.size),
                        leadingContent = { Icon(Icons.Outlined.Description, null) },
                        supportingContent = {
                            Text(
                                listOfNotNull(
                                    document.pages?.let { pluralStringResource(R.plurals.room_documents_pages, it, it) },
                                    Formatter.formatShortFileSize(context, document.size),
                                    document.addedBy,
                                    DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(document.addedAt.toLong())),
                                    document.note,
                                ).joinToString(" · "),
                            )
                        },
                        trailingContent = {
                            Row {
                                IconButton(onClick = { download(document) }) { Icon(Icons.Outlined.Download, stringResource(R.string.room_download)) }
                                IconButton(onClick = { delete(document) }) { Icon(Icons.Outlined.Delete, stringResource(R.string.room_delete)) }
                            }
                        },
                    ) { Text(document.name) }
                }
            }
        }
    }
}

/** A picked file's name and type. */
private fun describe(context: Context, uri: Uri): Pair<String, String> {
    val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    } ?: uri.lastPathSegment ?: "document"
    return name to (context.contentResolver.getType(uri) ?: "application/octet-stream")
}
