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
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.MutableStateFlow
import nudge.client.Connector
import nudge.client.ConnectorsState
import nudge.client.ObservedConnectors
import nudge.client.observeConnectors
import nudge.ffi.NudgeClient
import nudge.ffi.PanelStatus

/**
 * The APIs the room's assistant can call. People ask for one in the chat; here they set what
 * only people set: what it's for and whether it comes first, API keys (the assistant never sees
 * them), the local network, and the calls that only read.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ConnectorsScreen(client: NudgeClient, roomId: String, close: () -> Unit) {
    val observed = remember(client, roomId) { MutableStateFlow<ObservedConnectors?>(null) }
    DisposableEffect(client, roomId) {
        val connectors = client.observeConnectors(roomId)
        observed.value = connectors
        onDispose { connectors.close() }
    }
    val connectors by observed.collectAsStateWithLifecycle()
    val state = connectors?.state?.collectAsStateWithLifecycle()?.value ?: ConnectorsState()
    var removing by remember { mutableStateOf<Connector?>(null) }

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text("Connectors") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, "Close") } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            val status = state.status
            val all = state.connectors
            val panel = connectors
            when {
                status is PanelStatus.Closed && status.code.toInt() == 4404 -> Text(
                    "No connectors here. Turn on the connectors extension for this room under About this room.",
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
                            "APIs this room's assistant can call. Ask it in the chat to add one, and say what for. " +
                                "Turn on Always use first to have it try one before anything else for those tasks. " +
                                "API keys go here only: the assistant never sees them.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                    state.error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) } }
                    if (all.isEmpty()) {
                        item { Text("No connectors yet.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp)) }
                    }
                    items(all, key = { it.id }) { connector ->
                        ConnectorCard(connector, panel, state.admin, remove = { removing = connector })
                    }
                }
            }
        }
    }

    removing?.let { connector ->
        AlertDialog(
            onDismissRequest = { removing = null },
            icon = { Icon(Icons.Outlined.Delete, null) },
            title = { Text("Remove ${connector.name}?") },
            text = { Text("The assistant can't call it any more, and its API key is forgotten.") },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    connectors?.remove(connector)
                }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ConnectorCard(connector: Connector, panel: ObservedConnectors, admin: Boolean, remove: () -> Unit) {
    var key by remember(connector.id) { mutableStateOf("") }
    var readPaths by remember(connector.id, connector.readPaths) { mutableStateOf(connector.readPaths.joinToString("\n")) }
    var useFor by remember(connector.id, connector.useFor) { mutableStateOf(connector.useFor) }
    var menu by remember { mutableStateOf(false) }
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(connector.name, style = MaterialTheme.typography.titleMedium)
                    Text(
                        "${connector.id} · ${connector.baseUrl}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (connector.shared) {
                    Text("Shared with every room", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!connector.shared || admin) {
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "Connector actions") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            if (admin) {
                                DropdownMenuItem(
                                    text = { Text(if (connector.shared) "Stop sharing with every room" else "Share with every room") },
                                    onClick = {
                                        menu = false
                                        if (connector.shared) panel.unshare(connector) else panel.share(connector)
                                    },
                                )
                            }
                            if (!connector.shared) {
                                DropdownMenuItem(text = { Text("Remove") }, onClick = {
                                    menu = false
                                    remove()
                                })
                            }
                        }
                    }
                }
            }
            if (connector.shared) Text(if (connector.alwaysFirst) "Used first for: ${connector.useFor}" else connector.useFor)
            if (connector.notes.isNotBlank()) {
                Text(
                    "Learned: ${connector.notes}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (connector.shared) return@Column

            OutlinedTextField(
                value = useFor,
                onValueChange = { useFor = it },
                label = { Text("Use it for") },
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.fillMaxWidth(),
            )
            FilledTonalButton(
                onClick = { panel.setUseFor(connector, useFor.trim()) },
                enabled = useFor.isNotBlank() && useFor.trim() != connector.useFor,
                shapes = ButtonDefaults.shapes(),
            ) { Text("Save") }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Always use first")
                    Text(
                        "Tried before browsing or answering from memory, for what it's for",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = connector.alwaysFirst,
                    onCheckedChange = { panel.setAlwaysFirst(connector, it) },
                )
            }

            connector.auth?.let { auth ->
                Text(
                    "API key (${auth.placement} ${auth.name}): ${if (connector.hasKey) "set" else "not set"}",
                    style = MaterialTheme.typography.labelLarge,
                    color = if (connector.hasKey) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.tertiary,
                )
                // Typed without being shown, and cleared once sent: the key never comes back.
                OutlinedTextField(
                    value = key,
                    onValueChange = { key = it },
                    placeholder = { Text(if (connector.hasKey) "Replace the key" else "Paste the key") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(
                        onClick = {
                            panel.setKey(connector, key.trim())
                            key = ""
                        },
                        enabled = key.isNotBlank(),
                        shapes = ButtonDefaults.shapes(),
                    ) { Text("Save key") }
                    if (connector.hasKey) {
                        OutlinedButton(onClick = { panel.clearKey(connector) }, shapes = ButtonDefaults.shapes()) { Text("Clear") }
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Local network")
                    Text(
                        "May reach this machine and the local network, such as Home Assistant or a NAS",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = connector.allowPrivateNetwork,
                    onCheckedChange = { panel.allowPrivateNetwork(connector, it) },
                )
            }

            Text(
                "Calls that only read, though not GET: one METHOD /path per line, such as POST /graphql. They run without asking.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = readPaths,
                onValueChange = { readPaths = it },
                placeholder = { Text("POST /graphql") },
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                minLines = 2,
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.fillMaxWidth(),
            )
            FilledTonalButton(
                onClick = { panel.setReadPaths(connector, readPaths.lines().map { it.trim() }.filter { it.isNotEmpty() }) },
                enabled = readPaths.lines().map { it.trim() }.filter { it.isNotEmpty() } != connector.readPaths,
                shapes = ButtonDefaults.shapes(),
            ) { Text("Save read paths") }
        }
    }
}
