package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.McpKey
import app.nudge.McpServer
import app.nudge.McpServersState
import app.nudge.ObservedMcpServers
import app.nudge.observeMcpServers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import nudge.ffi.NudgeClient
import nudge.ffi.PanelStatus

/** Which calls wait for a person's approval, as the extension names them. */
private val APPROVALS = listOf(
    "writes" to "Ask before calls that change something",
    "always" to "Ask before every call",
    "never" to "Never ask",
)

/**
 * The MCP servers the room's assistant can use. People ask for one in the chat; here they set what
 * only people set: keys and sign-ins (the assistant never sees them), and which calls wait for
 * approval. [server] is the address the app reaches the server by, for a sign-in to come back to.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun McpServersScreen(client: NudgeClient, roomId: String, server: String, close: () -> Unit) {
    val observed = remember(client, roomId) { MutableStateFlow<ObservedMcpServers?>(null) }
    DisposableEffect(client, roomId) {
        val servers = client.observeMcpServers(roomId)
        observed.value = servers
        onDispose { servers.close() }
    }
    val servers by observed.collectAsStateWithLifecycle()
    val state = servers?.state?.collectAsStateWithLifecycle()?.value ?: McpServersState()
    var removing by remember { mutableStateOf<McpServer?>(null) }

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text("MCP servers") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, "Close") } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            val status = state.status
            val all = state.servers
            val panel = servers
            when {
                status is PanelStatus.Closed && status.code.toInt() == 4404 -> Text(
                    "No MCP servers here. Turn on the mcp extension for this room under About this room.",
                    Modifier.align(Alignment.Center).padding(32.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                all == null || panel == null -> LoadingIndicator(Modifier.align(Alignment.Center))
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item {
                        Text(
                            "MCP servers this room's assistant can use. Ask it in the chat to add one. Keys and sign-ins " +
                                "go here only: the assistant never sees them.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                    state.error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) } }
                    if (all.isEmpty()) {
                        item { Text("No MCP servers yet.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp)) }
                    }
                    items(all, key = { it.id }) { mcp ->
                        McpServerCard(mcp, panel, server, remove = { removing = mcp })
                    }
                }
            }
        }
    }

    removing?.let { mcp ->
        AlertDialog(
            onDismissRequest = { removing = null },
            icon = { Icon(Icons.Outlined.Delete, null) },
            title = { Text("Remove ${mcp.name}?") },
            text = { Text("The assistant can't use it any more, and its keys and sign-in are forgotten.") },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    servers?.remove(mcp)
                }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun McpServerCard(mcp: McpServer, panel: ObservedMcpServers, base: String, remove: () -> Unit) {
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    var signingIn by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(mcp.name, style = MaterialTheme.typography.titleMedium)
                    Text(
                        mcp.runs,
                        style = MaterialTheme.typography.bodySmall.let {
                            if (mcp.command == null) it else it.copy(fontFamily = FontFamily.Monospace)
                        },
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "Server actions") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Remove") }, onClick = {
                            menu = false
                            remove()
                        })
                    }
                }
            }
            Text(mcp.useFor)
            Text(
                "Added by ${mcp.addedBy}" + (mcp.tools?.let { " · $it ${if (it == 1) "tool" else "tools"}" } ?: ""),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            mcp.problem?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.tertiary) }

            mcp.keys.forEach { key -> McpKeyForm(mcp, key, panel) }

            // A remote server without keys may ask for an OAuth sign-in, in the browser; it comes
            // back to the Nudge server, not to the app.
            if (mcp.url != null && mcp.keys.isEmpty()) {
                Text(
                    if (mcp.signedIn) "Signed in." else "Not signed in. Servers that need it ask for it.",
                    style = MaterialTheme.typography.labelLarge,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(
                        onClick = {
                            signingIn = true
                            scope.launch {
                                try {
                                    panel.signIn(mcp, base)?.let { runCatching { uriHandler.openUri(it) } }
                                } finally {
                                    signingIn = false
                                }
                            }
                        },
                        enabled = !signingIn,
                        shapes = ButtonDefaults.shapes(),
                    ) { Text(if (mcp.signedIn) "Sign in again" else "Sign in") }
                    if (mcp.signedIn) {
                        OutlinedButton(onClick = { panel.signOut(mcp) }, shapes = ButtonDefaults.shapes()) { Text("Sign out") }
                    }
                }
            }

            Text("Approval", style = MaterialTheme.typography.labelLarge)
            APPROVALS.forEach { (approval, label) ->
                Row(
                    Modifier.fillMaxWidth().selectable(selected = mcp.approval == approval, onClick = {
                        if (mcp.approval != approval) panel.setApproval(mcp, approval)
                    }),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = mcp.approval == approval, onClick = null)
                    Text(label, Modifier.padding(start = 12.dp))
                }
            }
            OutlinedButton(onClick = { panel.refresh(mcp) }, shapes = ButtonDefaults.shapes()) { Text("Try again") }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun McpKeyForm(mcp: McpServer, key: McpKey, panel: ObservedMcpServers) {
    var value by remember(mcp.id, key.name) { mutableStateOf("") }
    Text(
        "${if (key.placement == "header") "Header" else "Variable"} ${key.name}: ${if (key.set) "set" else "not set"}",
        style = MaterialTheme.typography.labelLarge,
        color = if (key.set) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.tertiary,
    )
    // Typed without being shown, and cleared once sent: the key never comes back.
    OutlinedTextField(
        value = value,
        onValueChange = { value = it },
        placeholder = {
            Text(if (key.set) "Replace it" else "Paste it" + (key.prefix?.trim()?.takeIf { it.isNotEmpty() }?.let { " (without \"$it\")" } ?: ""))
        },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth(),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilledTonalButton(
            onClick = {
                panel.setKey(mcp, key, value.trim())
                value = ""
            },
            enabled = value.isNotBlank(),
            shapes = ButtonDefaults.shapes(),
        ) { Text("Save") }
        if (key.set) {
            OutlinedButton(onClick = { panel.clearKey(mcp, key) }, shapes = ButtonDefaults.shapes()) { Text("Clear") }
        }
    }
}
