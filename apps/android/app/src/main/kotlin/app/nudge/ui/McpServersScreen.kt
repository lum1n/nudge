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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.McpKey
import app.nudge.McpServer
import app.nudge.McpServersState
import app.nudge.ObservedMcpServers
import app.nudge.R
import app.nudge.observeMcpServers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import nudge.ffi.NudgeClient
import nudge.ffi.PanelStatus

/** Which calls wait for a person's approval, as the extension names them. */
private val APPROVALS = listOf(
    "writes" to R.string.panels_mcp_ask_writes,
    "always" to R.string.panels_mcp_ask_always,
    "never" to R.string.panels_mcp_ask_never,
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
                title = { Text(stringResource(R.string.panels_mcp)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, stringResource(R.string.panels_close)) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            val status = state.status
            val all = state.servers
            val panel = servers
            when {
                status is PanelStatus.Closed && status.code.toInt() == 4404 -> Text(
                    stringResource(R.string.panels_mcp_off),
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
                            stringResource(R.string.panels_mcp_intro),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                    state.error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) } }
                    if (all.isEmpty()) {
                        item { Text(stringResource(R.string.panels_mcp_empty), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp)) }
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
            title = { Text(stringResource(R.string.panels_remove_title, mcp.name)) },
            text = { Text(stringResource(R.string.panels_mcp_remove_text)) },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    servers?.remove(mcp)
                }) { Text(stringResource(R.string.panels_remove)) }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.panels_cancel)) } },
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
                    IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.panels_mcp_actions)) }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text(stringResource(R.string.panels_remove)) }, onClick = {
                            menu = false
                            remove()
                        })
                    }
                }
            }
            Text(mcp.useFor)
            Text(
                stringResource(R.string.panels_mcp_added_by, mcp.addedBy) +
                    (mcp.tools?.let { " · " + pluralStringResource(R.plurals.panels_mcp_tools, it, it) } ?: ""),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            mcp.problem?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.tertiary) }

            mcp.keys.forEach { key -> McpKeyForm(mcp, key, panel) }

            // A remote server without keys may ask for an OAuth sign-in, in the browser; it comes
            // back to the Nudge server, not to the app.
            if (mcp.url != null && mcp.keys.isEmpty()) {
                Text(
                    stringResource(if (mcp.signedIn) R.string.panels_mcp_signed_in else R.string.panels_mcp_not_signed_in),
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
                    ) { Text(stringResource(if (mcp.signedIn) R.string.panels_mcp_sign_in_again else R.string.panels_mcp_sign_in)) }
                    if (mcp.signedIn) {
                        OutlinedButton(onClick = { panel.signOut(mcp) }, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.panels_mcp_sign_out)) }
                    }
                }
            }

            Text(stringResource(R.string.panels_mcp_approval), style = MaterialTheme.typography.labelLarge)
            APPROVALS.forEach { (approval, label) ->
                Row(
                    Modifier.fillMaxWidth().selectable(selected = mcp.approval == approval, onClick = {
                        if (mcp.approval != approval) panel.setApproval(mcp, approval)
                    }),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = mcp.approval == approval, onClick = null)
                    Text(stringResource(label), Modifier.padding(start = 12.dp))
                }
            }
            OutlinedButton(onClick = { panel.refresh(mcp) }, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.panels_mcp_try_again)) }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun McpKeyForm(mcp: McpServer, key: McpKey, panel: ObservedMcpServers) {
    var value by remember(mcp.id, key.name) { mutableStateOf("") }
    Text(
        stringResource(
            when {
                key.placement == "header" && key.set -> R.string.panels_mcp_header_set
                key.placement == "header" -> R.string.panels_mcp_header_not_set
                key.set -> R.string.panels_mcp_variable_set
                else -> R.string.panels_mcp_variable_not_set
            },
            key.name,
        ),
        style = MaterialTheme.typography.labelLarge,
        color = if (key.set) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.tertiary,
    )
    // Typed without being shown, and cleared once sent: the key never comes back.
    OutlinedTextField(
        value = value,
        onValueChange = { value = it },
        placeholder = {
            val prefix = key.prefix?.trim()?.takeIf { it.isNotEmpty() }
            Text(
                when {
                    key.set -> stringResource(R.string.panels_mcp_replace)
                    prefix != null -> stringResource(R.string.panels_mcp_paste_without, prefix)
                    else -> stringResource(R.string.panels_mcp_paste)
                },
            )
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
        ) { Text(stringResource(R.string.panels_save)) }
        if (key.set) {
            OutlinedButton(onClick = { panel.clearKey(mcp, key) }, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.panels_clear)) }
        }
    }
}
