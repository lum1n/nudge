package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledIconToggleButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.Dictation
import app.nudge.Session
import app.nudge.explain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import nudge.client.ObservedRoom
import nudge.client.RoomState
import nudge.client.activity
import nudge.client.observeRoomState
import nudge.client.transcript
import nudge.ffi.ApprovalStatus
import nudge.ffi.GoneReason
import nudge.ffi.NudgeClient
import nudge.ffi.QueueMode
import nudge.ffi.RoomKind
import nudge.ffi.Status
import nudge.ffi.SyncStatus

/** A room: its timeline as it streams, this device's messages on their way, and the composer. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun RoomScreen(
    session: Session,
    roomId: String,
    dictation: Dictation,
    back: (() -> Unit)?,
    lists: () -> Unit,
    info: () -> Unit,
    browser: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val client = session.client
    val observed = remember(client, roomId) { MutableStateFlow<ObservedRoom?>(null) }
    DisposableEffect(client, roomId) {
        val room = client.observeRoomState(roomId)
        observed.value = room
        onDispose { room.close() }
    }
    val room by observed.collectAsStateWithLifecycle()
    val state = room?.state?.collectAsStateWithLifecycle()?.value
    val me by session.me.collectAsStateWithLifecycle()
    var draft by remember(roomId) { mutableStateOf("") }
    var secret by remember(roomId) { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var showActivity by remember(roomId) { mutableStateOf(false) }
    var dictating by remember(roomId) { mutableStateOf(false) }

    fun attempt(action: suspend () -> Unit) = scope.launch {
        try {
            action()
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    Scaffold(
        bottomBar = {
            if (state?.status != SyncStatus.GONE) {
                Column(Modifier.imePadding()) {
                    // Asked for by a tool and waiting: the activity shows them once decided.
                    state?.approvals?.filter { it.status == ApprovalStatus.PENDING }?.forEach { approval ->
                        Box(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                            ApprovalCard(approval.summary, approval.status, null) { approve ->
                                attempt { client.decide(roomId, approval.id, approve) }
                            }
                        }
                    }
                    state?.live?.status?.let { LiveStatus(it) }
                    Composer(
                        draft = draft,
                        onDraft = {
                            // Typing takes over from dictation; what it heard stays in the field.
                            if (dictating) {
                                dictating = false
                                dictation.cancel()
                            }
                            draft = it
                        },
                        running = state?.live?.running == true,
                        // Only in a shared room is there anyone to keep a message from.
                        secret = if (state?.room?.kind == RoomKind.PERSONAL) null else secret,
                        onSecret = { secret = it },
                        send = {
                            val text = draft.trim()
                            if (text.isNotEmpty()) {
                                if (dictating) {
                                    dictating = false
                                    dictation.cancel()
                                }
                                draft = ""
                                val private = secret && state?.room?.kind != RoomKind.PERSONAL
                                // A refused message stays pending, marked failed, with Retry and Dismiss.
                                scope.launch { runCatching { client.send(roomId, text, null, private) } }
                            }
                        },
                        stop = { attempt { client.abort(roomId) } },
                        mic = {
                            DictationButton(
                                dictation, roomId, draft,
                                onDraft = { draft = it },
                                dictating = dictating,
                                onDictating = { dictating = it },
                                problem = { problem = it },
                            )
                        },
                    )
                }
            }
        },
        topBar = {
            TopAppBar(
                title = { Text(state?.room?.name ?: "", maxLines = 1) },
                subtitle = {
                    val others = state?.room?.members.orEmpty().filter { it.id != me?.player?.id }
                    Text(
                        when {
                            state?.live?.running == true -> "Answering…"
                            others.isEmpty() -> "Just you"
                            else -> others.joinToString { it.displayName }
                        },
                        maxLines = 1,
                    )
                },
                navigationIcon = {
                    back?.let { IconButton(onClick = it) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Rooms") } }
                },
                actions = {
                    IconButton(onClick = { showActivity = true }) { Icon(Icons.Outlined.History, "Activity") }
                    IconButton(onClick = lists) { Icon(Icons.Outlined.Checklist, "Lists") }
                    IconButton(onClick = info) { Icon(Icons.Outlined.Info, "Room") }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                state?.status == SyncStatus.GONE -> Text(
                    if (state.reason == GoneReason.REMOVED) "You left this room" else "No such room",
                    Modifier.align(Alignment.Center),
                )
                state == null || (state.room == null && state.status == SyncStatus.SYNCING) ->
                    LoadingIndicator(Modifier.align(Alignment.Center))
                else -> Timeline(
                    state, me?.player?.id,
                    loadEarlier = { scope.launch { room?.loadEarlier() } },
                    retry = { requestId -> attempt { client.resend(roomId, requestId) } },
                    dismiss = { requestId -> client.dismiss(roomId, requestId) },
                    openBrowser = browser,
                    openActivity = { showActivity = true },
                )
            }
        }
    }

    if (showActivity && state != null) {
        ModalBottomSheet(onDismissRequest = { showActivity = false }) {
            Activity(state, loadEarlier = { scope.launch { room?.loadEarlier() } }, openBrowser = browser)
        }
    }

    problem?.let { message ->
        AlertDialog(
            onDismissRequest = { problem = null },
            title = { Text("Something went wrong") },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = { problem = null }) { Text("OK") } },
        )
    }
}

/** The timeline, newest at the bottom: then queued messages, then this device's pending ones. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Timeline(
    state: RoomState,
    me: String?,
    loadEarlier: () -> Unit,
    retry: (String) -> Unit,
    dismiss: (String) -> Unit,
    openBrowser: () -> Unit,
    openActivity: () -> Unit,
) {
    // Laid out from the bottom, so a growing answer stays in view.
    val listState = rememberLazyListState()
    val pending = state.pending.reversed()
    val pendingIds = state.pending.map { it.requestId }.toSet()
    val queued = state.queue.filter { !it.nudge && it.requestId !in pendingIds }.reversed()
    LazyColumn(
        state = listState,
        reverseLayout = true,
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.Bottom),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
    ) {
        items(pending, key = { "pending:${it.requestId}" }) { message ->
            PendingRow(message, retry = { retry(message.requestId) }, dismiss = { dismiss(message.requestId) })
        }
        items(queued, key = { "queued:${it.id}" }) { message ->
            val mine = message.author == null || message.author?.id == me
            Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start, modifier = Modifier.fillMaxWidth()) {
                Bubble(message.text, mine, if (mine) null else message.author?.displayName, faded = true)
                Text(
                    if (message.mode == QueueMode.STEER) "next" else "queued",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        // Tool calls, nudges and ended approvals are in the activity.
        items(state.timeline.transcript.asReversed(), key = { it.itemId }) { item ->
            TimelineRow(item, me, openBrowser, openActivity)
        }
        if (state.canLoadEarlier || state.loadingEarlier) {
            item(key = "earlier") {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (state.loadingEarlier) {
                        LoadingIndicator(Modifier.size(32.dp))
                    } else {
                        FilledTonalButton(onClick = loadEarlier, shapes = ButtonDefaults.shapes()) { Text("Load earlier") }
                    }
                }
            }
        }
        state.earlierError?.let { error ->
            item(key = "earlierError") { Text(error, color = MaterialTheme.colorScheme.error) }
        }
    }
}

/** What happened behind the transcript, newest first: tool calls, thinking, nudges, watches, approvals. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Activity(state: RoomState, loadEarlier: () -> Unit, openBrowser: () -> Unit) {
    val items = state.timeline.activity.asReversed()
    LazyColumn(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
    ) {
        item(key = "title") { Text("Activity", style = MaterialTheme.typography.titleLarge) }
        if (items.isEmpty()) {
            item(key = "empty") {
                Text(
                    "Nothing yet: tool calls, nudges, watches and approvals show up here.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        items(items, key = { it.itemId }) { item -> ActivityRow(item, openBrowser) }
        if (state.canLoadEarlier || state.loadingEarlier) {
            item(key = "earlier") {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (state.loadingEarlier) {
                        LoadingIndicator(Modifier.size(32.dp))
                    } else {
                        FilledTonalButton(onClick = loadEarlier, shapes = ButtonDefaults.shapes()) { Text("Load earlier") }
                    }
                }
            }
        }
        state.earlierError?.let { error ->
            item(key = "earlierError") { Text(error, color = MaterialTheme.colorScheme.error) }
        }
    }
}

/** The message field, and Send, or Stop while the assistant answers and the field is empty. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Composer(
    draft: String,
    onDraft: (String) -> Unit,
    running: Boolean,
    /** Whether the next message is private; null where there is nobody to keep it from. */
    secret: Boolean?,
    onSecret: (Boolean) -> Unit,
    send: () -> Unit,
    stop: () -> Unit,
    mic: @Composable () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (secret != null) {
                FilledIconToggleButton(
                    checked = secret,
                    onCheckedChange = onSecret,
                    shapes = IconButtonDefaults.toggleableShapes(),
                    modifier = Modifier.size(56.dp),
                ) {
                    Icon(
                        if (secret) Icons.Outlined.Lock else Icons.Outlined.LockOpen,
                        if (secret) "Private: only you see it and the answer" else "Send privately",
                    )
                }
            }
            TextField(
                value = draft,
                onValueChange = onDraft,
                placeholder = { Text(if (secret == true) "Private message" else "Message") },
                trailingIcon = mic,
                maxLines = 6,
                shape = MaterialTheme.shapes.extraLarge,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier.weight(1f),
            )
            val size = Modifier.size(56.dp)
            if (running && draft.isEmpty()) {
                FilledTonalIconButton(
                    onClick = stop,
                    shapes = IconButtonDefaults.shapes(),
                    colors = IconButtonDefaults.filledTonalIconButtonColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    ),
                    modifier = size,
                ) { Icon(Icons.Filled.Stop, "Stop") }
            } else {
                FilledIconButton(
                    onClick = send,
                    enabled = draft.isNotBlank(),
                    shapes = IconButtonDefaults.shapes(),
                    modifier = size,
                ) { Icon(Icons.AutoMirrored.Filled.Send, "Send") }
            }
        }
    }
}

/** Retrying after a model error, or compacting a long conversation. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun LiveStatus(status: Status) {
    val text = when (status) {
        is Status.Retrying -> "Trying again (${status.attempt}): ${status.error}"
        is Status.Compacting -> "Summarizing the conversation so far…"
        is Status.CompactionFailed -> "Couldn't summarize: ${status.error}"
    }
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (status !is Status.CompactionFailed) LoadingIndicator(Modifier.size(24.dp))
            Text(text, style = MaterialTheme.typography.bodySmall, maxLines = 2)
        }
    }
}
