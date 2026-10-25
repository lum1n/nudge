package app.nudge.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.R
import app.nudge.explain
import app.nudge.text
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import nudge.client.ObservedTerminal
import nudge.client.TerminalCommand
import nudge.client.TerminalState
import nudge.client.observeTerminal
import nudge.ffi.NudgeClient
import nudge.ffi.PanelStatus

/**
 * The room's terminal, live: the commands the assistant runs in the room's sandboxed workspace,
 * their output as it comes, newest first, and Approve and Deny for those that wait.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun TerminalScreen(client: NudgeClient, roomId: String, close: () -> Unit) {
    val observed = remember(client, roomId) { MutableStateFlow<ObservedTerminal?>(null) }
    DisposableEffect(client, roomId) {
        val terminal = client.observeTerminal(roomId)
        observed.value = terminal
        onDispose { terminal.close() }
    }
    val terminal by observed.collectAsStateWithLifecycle()
    val state = terminal?.state?.collectAsStateWithLifecycle()?.value ?: TerminalState()
    val scope = rememberCoroutineScope()
    var problem by remember { mutableStateOf<String?>(null) }
    fun decide(approval: String, approve: Boolean) = scope.launch {
        try {
            client.decide(roomId, approval, approve)
            problem = null
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(stringResource(R.string.panels_terminal)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, stringResource(R.string.panels_close)) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val status = state.status
            val commands = state.commands
            when {
                status is PanelStatus.Closed && status.code.toInt() == 4404 -> Text(
                    stringResource(R.string.panels_terminal_off),
                    Modifier.align(Alignment.Center).padding(32.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                commands == null -> LoadingIndicator(Modifier.align(Alignment.Center))
                commands.isEmpty() -> Text(
                    stringResource(R.string.panels_terminal_empty),
                    Modifier.align(Alignment.Center).padding(32.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    (problem ?: state.error)?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
                    // Newest first: what runs now is what one comes here for.
                    items(commands.asReversed(), key = { it.id }) { command ->
                        CommandCard(command) { approve -> command.approval?.let { decide(it, approve) } }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun CommandCard(command: TerminalCommand, decide: (Boolean) -> Unit) {
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SelectionContainer {
                Text(
                    (command.cwd?.let { "$it " } ?: "") + "$ " + command.command,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Text(
                statusLine(command),
                style = MaterialTheme.typography.labelMedium,
                color = when (command.status) {
                    "failed", "stopped" -> MaterialTheme.colorScheme.error
                    "waiting" -> MaterialTheme.colorScheme.tertiary
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
            if (command.status == "waiting" && command.approval != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { decide(true) }, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.room_approve)) }
                    OutlinedButton(onClick = { decide(false) }, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.room_deny)) }
                }
            }
            if (command.output.isNotEmpty()) Output(command.output, follow = command.status == "running")
        }
    }
}

/** A command's output, on dark like a terminal; it follows the end while the command runs. */
@Composable
private fun Output(text: String, follow: Boolean) {
    val vertical = rememberScrollState()
    LaunchedEffect(text, follow) { if (follow) vertical.scrollTo(vertical.maxValue) }
    SelectionContainer(
        Modifier.fillMaxWidth()
            .heightIn(max = 320.dp)
            .background(Color(0xFF1C1917), MaterialTheme.shapes.small)
            .verticalScroll(vertical)
            .horizontalScroll(rememberScrollState())
            .padding(8.dp),
    ) {
        Text(text, color = Color(0xFFF5F5F4), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
    }
}

private fun statusLine(command: TerminalCommand): String {
    val state = when (command.status) {
        "waiting" -> text(R.string.panels_terminal_waiting)
        "running" -> text(R.string.panels_terminal_running)
        "done" -> text(R.string.panels_terminal_exit, 0)
        "failed" -> command.exitCode?.let { text(R.string.panels_terminal_exit, it) } ?: text(R.string.panels_terminal_failed)
        "stopped" -> text(R.string.panels_terminal_stopped)
        "denied" -> text(R.string.panels_terminal_denied)
        else -> command.status
    }
    val decided = command.decidedBy?.let {
        if (command.status == "denied") " " + text(R.string.panels_terminal_denied_by, it) else " · " + text(R.string.panels_terminal_approved_by, it)
    } ?: ""
    val ending = command.ending?.let { ": $it" } ?: ""
    val time = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(command.startedAt.toLong()))
    return "$state$ending$decided · $time"
}
