package nudge.sample

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import nudge.ffi.AnswerStatus
import nudge.ffi.ApprovalStatus
import nudge.ffi.ConnectionStatus
import nudge.ffi.Part
import nudge.ffi.PendingState
import nudge.ffi.SyncStatus
import nudge.ffi.TimelineItem

class MainActivity : ComponentActivity() {
    private val model: NudgeViewModel by viewModels()
    private var link by mutableStateOf<Uri?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        link = intent?.data
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) {
                    App(model, link)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        link = intent.data
    }
}

@Composable
fun App(model: NudgeViewModel, link: Uri?) {
    val session by model.session.collectAsStateWithLifecycle()
    val error by model.error.collectAsStateWithLifecycle()
    var room by rememberSaveable { mutableStateOf<String?>(null) }

    // A `nudge://pair?server=…&assistant=…&code=…` link signs in at once.
    LaunchedEffect(link) {
        val server = link?.getQueryParameter("server")
        val assistant = link?.getQueryParameter("assistant")
        val code = link?.getQueryParameter("code")
        if (server != null && assistant != null && code != null) {
            model.signOut()
            model.pair(server, assistant, code)
        }
    }

    Column(Modifier.safeDrawingPadding().imePadding()) {
        error?.let {
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer).padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(it, Modifier.weight(1f), color = MaterialTheme.colorScheme.onErrorContainer)
                TextButton(onClick = model::clearError) { Text("OK") }
            }
        }
        val current = session
        when {
            current == null -> SignIn(model)
            room == null -> Rooms(model, current, onOpen = { room = it })
            else -> RoomScreen(model, room!!, onBack = { room = null })
        }
    }
}

@Composable
fun SignIn(model: NudgeViewModel) {
    var server by rememberSaveable { mutableStateOf("http://10.0.2.2:8787") }
    var assistant by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Sign in to Nudge", style = MaterialTheme.typography.headlineSmall)
        Text("Ask an admin for a pairing code (`nudge pair <player>`).")
        OutlinedTextField(server, { server = it }, label = { Text("Server") }, singleLine = true)
        OutlinedTextField(assistant, { assistant = it }, label = { Text("Assistant") }, singleLine = true)
        OutlinedTextField(code, { code = it }, label = { Text("Pairing code") }, singleLine = true)
        Button(
            onClick = { model.pair(server, assistant, code) },
            enabled = server.isNotBlank() && assistant.isNotBlank() && code.isNotBlank(),
        ) { Text("Sign in") }
    }
}

@Composable
fun Rooms(model: NudgeViewModel, session: Session, onOpen: (String) -> Unit) {
    val connection by session.connection.state.collectAsStateWithLifecycle()
    val home by session.home.state.collectAsStateWithLifecycle()
    LaunchedEffect(connection) {
        val status = connection
        if (status is ConnectionStatus.Closed && status.code.toInt() == 4401) model.signOut()
    }
    Column {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(home?.view?.player?.displayName ?: "Nudge", style = MaterialTheme.typography.titleLarge)
                Text(describe(connection), style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = model::signOut) { Text("Sign out") }
        }
        HorizontalDivider()
        LazyColumn {
            items(home?.view?.rooms.orEmpty(), key = { it.room.id }) { entry ->
                Column(Modifier.fillMaxWidth().clickable { onOpen(entry.room.id) }.padding(16.dp)) {
                    Text(entry.room.name, style = MaterialTheme.typography.titleMedium)
                    val notes = listOfNotNull(
                        entry.room.members.joinToString { it.displayName },
                        "answering…".takeIf { entry.running },
                        "${entry.pendingApprovals} to approve".takeIf { entry.pendingApprovals > 0u },
                    )
                    Text(notes.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
fun RoomScreen(model: NudgeViewModel, id: String, onBack: () -> Unit) {
    val observed = remember(id) { model.room(id) } ?: return
    DisposableEffect(observed) { onDispose { observed.close() } }
    val state by observed.state.collectAsStateWithLifecycle()
    var draft by rememberSaveable { mutableStateOf("") }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    BackHandler(onBack = onBack)

    val timeline = state?.timeline.orEmpty()
    LaunchedEffect(timeline.size, timeline.lastOrNull()) {
        if (timeline.isNotEmpty()) list.animateScrollToItem(timeline.size - 1)
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("Back") }
            Text(state?.room?.name ?: id, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            if (state?.live?.running == true) OutlinedButton(onClick = { model.abort(id) }) { Text("Stop") }
        }
        HorizontalDivider()
        when (state?.status) {
            SyncStatus.GONE -> Text("This room is gone.", Modifier.padding(16.dp))
            else -> LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp), state = list) {
                if (state?.canLoadEarlier == true) {
                    item {
                        TextButton(onClick = { scope.launch { observed.loadEarlier() } }) {
                            Text(if (state?.loadingEarlier == true) "Loading…" else "Load earlier")
                        }
                    }
                }
                items(timeline, key = { itemId(it) }) { item -> Item(model, id, item) }
                items(state?.pending.orEmpty(), key = { "pending:" + it.requestId }) { pending ->
                    Bubble(mine = true) {
                        Text(pending.text)
                        when (val s = pending.state) {
                            is PendingState.Failed -> Row {
                                Text("Not sent: ${s.error}", style = MaterialTheme.typography.bodySmall)
                                TextButton(onClick = { model.resend(id, pending.requestId) }) { Text("Retry") }
                                TextButton(onClick = { model.dismiss(id, pending.requestId) }) { Text("Dismiss") }
                            }
                            is PendingState.Waiting -> Text("Waiting to send…", style = MaterialTheme.typography.bodySmall)
                            PendingState.Sending -> Text("Sending…", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(draft, { draft = it }, Modifier.weight(1f), placeholder = { Text("Message") })
            Spacer(Modifier.padding(4.dp))
            Button(
                onClick = {
                    model.send(id, draft.trim())
                    draft = ""
                },
                enabled = draft.isNotBlank(),
            ) { Text("Send") }
        }
    }
}

@Composable
fun Item(model: NudgeViewModel, room: String, item: TimelineItem) {
    when (item) {
        is TimelineItem.User -> Bubble(mine = false) {
            Text(item.author?.displayName ?: "Someone", style = MaterialTheme.typography.labelMedium)
            Text(item.text)
        }
        is TimelineItem.Answer -> Bubble(mine = false, assistant = true) {
            for (part in item.parts) {
                when (part) {
                    is Part.Text -> Text(part.text)
                    is Part.Reasoning -> Unit
                    is Part.Tool -> Text("⚙ ${part.tool.name}", style = MaterialTheme.typography.bodySmall)
                }
            }
            when (item.status) {
                AnswerStatus.RUNNING -> Text("…", style = MaterialTheme.typography.bodySmall)
                AnswerStatus.STOPPED -> Text("stopped", style = MaterialTheme.typography.bodySmall)
                AnswerStatus.FAILED -> Text("failed: ${item.error ?: ""}", style = MaterialTheme.typography.bodySmall)
                AnswerStatus.DONE -> Unit
            }
        }
        is TimelineItem.Nudge -> Note("⏰ ${item.text}")
        is TimelineItem.Approval -> Bubble(mine = false, assistant = true) {
            Text(item.summary)
            if (item.status == ApprovalStatus.PENDING) {
                Row {
                    TextButton(onClick = { model.decide(room, item.approvalId, true) }) { Text("Approve") }
                    TextButton(onClick = { model.decide(room, item.approvalId, false) }) { Text("Deny") }
                }
            } else {
                Text(item.status.name.lowercase(), style = MaterialTheme.typography.bodySmall)
            }
        }
        is TimelineItem.Marker -> Note("— ${item.kind.name.lowercase()} —")
    }
}

@Composable
fun Bubble(mine: Boolean, assistant: Boolean = false, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(vertical = 4.dp), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
        val color = if (assistant) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.primaryContainer
        Column(Modifier.widthIn(max = 320.dp).background(color, RoundedCornerShape(12.dp)).padding(10.dp)) {
            content()
        }
    }
}

@Composable
fun Note(text: String) {
    Text(text, Modifier.fillMaxWidth().padding(8.dp), style = MaterialTheme.typography.bodySmall)
}

private fun itemId(item: TimelineItem): String = when (item) {
    is TimelineItem.User -> item.id
    is TimelineItem.Answer -> item.id
    is TimelineItem.Nudge -> item.id
    is TimelineItem.Approval -> item.id
    is TimelineItem.Marker -> item.id
}

private fun describe(status: ConnectionStatus?): String = when (status) {
    null, is ConnectionStatus.Connecting -> "Connecting…"
    is ConnectionStatus.Open -> "Connected"
    is ConnectionStatus.Waiting -> "Reconnecting…"
    is ConnectionStatus.Closed -> "Disconnected (${status.code})"
}
