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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.Dictation
import app.nudge.R
import app.nudge.avatar.Avatar
import app.nudge.avatar.LocalRobotLook
import app.nudge.avatar.Mood
import app.nudge.avatar.presenceLabel
import app.nudge.avatar.roomMood
import app.nudge.Session
import app.nudge.explain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import nudge.client.ObservedRoom
import nudge.client.RoomState
import nudge.client.activity
import nudge.client.dayStarts
import nudge.client.itemId
import nudge.client.observeRoomState
import nudge.client.transcript
import nudge.ffi.ApprovalStatus
import nudge.ffi.GoneReason
import nudge.ffi.NudgeClient
import nudge.ffi.QueueMode
import nudge.ffi.RoomKind
import nudge.ffi.Status
import nudge.ffi.SyncStatus
import nudge.ffi.attachmentsPerMessage

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
    val picked = remember(client, roomId) { ComposerAttachments(client, roomId) }
    val attachments = remember(client, roomId) { RoomAttachments(client, roomId) }
    val resolver = LocalContext.current.contentResolver
    var secret by remember(roomId) { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var showActivity by remember(roomId) { mutableStateOf(false) }
    var dictating by remember(roomId) { mutableStateOf(false) }
    val heard = dictation.state.collectAsStateWithLifecycle()
    // Not the level itself, which changes many times a second: the robot reads that as it draws.
    val listening by remember { derivedStateOf { heard.value is Dictation.State.Listening } }
    val mood = roomMood(
        state?.timeline.orEmpty(), state?.live, state?.approvals.orEmpty(),
        listening = dictating && listening,
    )
    // The mic's loudness, for the robot to follow while it listens; otherwise its own made-up voice.
    val level = remember(dictation) { { (dictation.state.value as? Dictation.State.Listening)?.level?.toDouble() } }

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
                    // Asked for by a tool and waiting: the activity shows them once decided. TalkBack
                    // reads out a new one as it comes.
                    Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                        state?.approvals?.filter { it.status == ApprovalStatus.PENDING }?.forEach { approval ->
                            Box(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                                ApprovalCard(approval.summary, approval.status, null) { approve ->
                                    attempt { client.decide(roomId, approval.id, approve) }
                                }
                            }
                        }
                    }
                    state?.live?.status?.let { LiveStatus(it) }
                    // In an empty room the robot is in the middle of it instead.
                    if (state != null && (state.timeline.transcript.isNotEmpty() || state.pending.isNotEmpty())) {
                        Presence(mood, presenceLabel(mood, state.timeline, state.live), session.account.assistantName, level)
                    }
                    PickedChips(picked.picked, state?.room?.imagesToModel == true) { key ->
                        scope.launch { picked.remove(key) }
                    }
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
                        attachable = picked.picked.size < attachmentsPerMessage().toInt(),
                        attach = { uris -> scope.launch { picked.add(resolver, uris) } },
                        sendable = (draft.isNotBlank() || picked.ready.isNotEmpty()) && !picked.uploading,
                        send = {
                            val text = draft.trim()
                            if ((text.isNotEmpty() || picked.ready.isNotEmpty()) && !picked.uploading) {
                                if (dictating) {
                                    dictating = false
                                    dictation.cancel()
                                }
                                draft = ""
                                val private = secret && state?.room?.kind != RoomKind.PERSONAL
                                val files = picked.take()
                                // A refused message stays pending, marked failed, with Retry and Dismiss.
                                scope.launch { runCatching { client.send(roomId, text, null, private, files) } }
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
                    // Whose location the assistant knows here, for everyone in the room to see.
                    val you = stringResource(R.string.room_location_you)
                    val located = state?.sharingLocation.orEmpty()
                        .map { if (it.id == me?.player?.id) you else it.displayName }
                    val names = located.joinToString(stringResource(R.string.room_location_and))
                    Text(
                        when {
                            state?.live?.running == true -> stringResource(R.string.room_answering)
                            others.isEmpty() -> stringResource(R.string.room_just_you)
                            else -> others.joinToString { it.displayName }
                        } + if (located.isEmpty()) "" else stringResource(
                            if (located == listOf(you) || located.size > 1) R.string.room_location_are else R.string.room_location_is,
                            names,
                        ),
                        maxLines = 1,
                    )
                },
                navigationIcon = {
                    back?.let { IconButton(onClick = it) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.room_rooms)) } }
                },
                actions = {
                    IconButton(onClick = { showActivity = true }) { Icon(Icons.Outlined.History, stringResource(R.string.room_activity)) }
                    IconButton(onClick = lists) { Icon(Icons.Outlined.Checklist, stringResource(R.string.room_lists)) }
                    IconButton(onClick = info) { Icon(Icons.Outlined.Info, stringResource(R.string.room_room)) }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                state?.status == SyncStatus.GONE -> Text(
                    stringResource(if (state.reason == GoneReason.REMOVED) R.string.room_left else R.string.room_no_such_room),
                    Modifier.align(Alignment.Center),
                )
                state == null || (state.room == null && state.status == SyncStatus.SYNCING) ->
                    LoadingIndicator(Modifier.align(Alignment.Center))
                else -> CompositionLocalProvider(LocalRoomAttachments provides attachments) { Timeline(
                    state, me?.player?.id, session.account.assistantName, mood, level,
                    loadEarlier = { scope.launch { room?.loadEarlier() } },
                    retry = { requestId -> attempt { client.resend(roomId, requestId) } },
                    dismiss = { requestId -> client.dismiss(roomId, requestId) },
                    openBrowser = browser,
                    openActivity = { showActivity = true },
                ) }
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
            title = { Text(stringResource(R.string.room_problem_title)) },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = { problem = null }) { Text(stringResource(R.string.room_ok)) } },
        )
    }
}

/** The timeline, newest at the bottom: then queued messages, then this device's pending ones. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Timeline(
    state: RoomState,
    me: String?,
    assistant: String,
    mood: Mood,
    level: () -> Double?,
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
    val transcript = state.timeline.transcript
    val days = remember(transcript) { transcript.dayStarts() }
    if (transcript.isEmpty() && pending.isEmpty() && queued.isEmpty() && !state.canLoadEarlier && !state.loadingEarlier) {
        Column(
            Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Avatar(mood, appearance = LocalRobotLook.current, size = 160.dp, level = level, title = assistant)
            Text(stringResource(R.string.room_say_hello, assistant), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
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
            Column(
                horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
                modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
            ) {
                Bubble(attachmentsLabel(message.text, message.attachments), mine, if (mine) null else message.author?.displayName, faded = true)
                Text(
                    stringResource(if (message.mode == QueueMode.STEER) R.string.room_queued_next else R.string.room_queued),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        // Tool calls, nudges and ended approvals are in the activity.
        items(transcript.asReversed(), key = { it.itemId }) { item ->
            Column {
                days[item.itemId]?.let { DayDivider(it) }
                TimelineRow(item, me, assistant, openBrowser, openActivity)
            }
        }
        if (state.canLoadEarlier || state.loadingEarlier) {
            item(key = "earlier") {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (state.loadingEarlier) {
                        LoadingIndicator(Modifier.size(32.dp))
                    } else {
                        FilledTonalButton(onClick = loadEarlier, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.room_load_earlier)) }
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
        item(key = "title") { Text(stringResource(R.string.room_activity), style = MaterialTheme.typography.titleLarge) }
        if (items.isEmpty()) {
            item(key = "empty") {
                Text(
                    stringResource(R.string.room_activity_empty),
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
                        FilledTonalButton(onClick = loadEarlier, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.room_load_earlier)) }
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
    /** Whether another file may go with this message. */
    attachable: Boolean,
    attach: (List<android.net.Uri>) -> Unit,
    /** Whether there is something to send: text, or files uploaded and none still on its way. */
    sendable: Boolean,
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
            if (attachable) AttachButton(attach)
            if (secret != null) {
                FilledIconToggleButton(
                    checked = secret,
                    onCheckedChange = onSecret,
                    shapes = IconButtonDefaults.toggleableShapes(),
                    modifier = Modifier.size(56.dp),
                ) {
                    Icon(
                        if (secret) Icons.Outlined.Lock else Icons.Outlined.LockOpen,
                        stringResource(if (secret) R.string.room_private_on else R.string.room_send_privately),
                    )
                }
            }
            TextField(
                value = draft,
                onValueChange = onDraft,
                placeholder = { Text(stringResource(if (secret == true) R.string.room_private_message else R.string.room_message)) },
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
            if (running && !sendable) {
                FilledTonalIconButton(
                    onClick = stop,
                    shapes = IconButtonDefaults.shapes(),
                    colors = IconButtonDefaults.filledTonalIconButtonColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    ),
                    modifier = size,
                ) { Icon(Icons.Filled.Stop, stringResource(R.string.room_stop)) }
            } else {
                FilledIconButton(
                    onClick = send,
                    enabled = sendable,
                    shapes = IconButtonDefaults.shapes(),
                    modifier = size,
                ) { Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.room_send)) }
            }
        }
    }
}

/** The robot, live, and a word on what it is doing. */
@Composable
private fun Presence(mood: Mood, label: String, assistant: String, level: () -> Double?) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Avatar(mood, appearance = LocalRobotLook.current, size = 40.dp, level = level, title = assistant)
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

/** Retrying after a model error, or compacting a long conversation. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun LiveStatus(status: Status) {
    val text = when (status) {
        is Status.Retrying -> stringResource(R.string.room_retrying, "${status.attempt}", status.error)
        is Status.Compacting -> stringResource(R.string.room_compacting)
        is Status.CompactionFailed -> stringResource(R.string.room_compaction_failed, status.error)
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
