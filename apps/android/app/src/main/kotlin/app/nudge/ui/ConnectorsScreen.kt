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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.R
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
                title = { Text(stringResource(R.string.panels_connectors)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, stringResource(R.string.panels_close)) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            val status = state.status
            val all = state.connectors
            val panel = connectors
            when {
                status is PanelStatus.Closed && status.code.toInt() == 4404 -> Text(
                    stringResource(R.string.panels_connectors_off),
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
                            stringResource(R.string.panels_connectors_intro),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                    state.error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) } }
                    if (all.isEmpty()) {
                        item { Text(stringResource(R.string.panels_connectors_empty), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp)) }
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
            title = { Text(stringResource(R.string.panels_remove_title, connector.name)) },
            text = { Text(stringResource(R.string.panels_connector_remove_text)) },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    connectors?.remove(connector)
                }) { Text(stringResource(R.string.panels_remove)) }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.panels_cancel)) } },
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
                    Text(stringResource(R.string.panels_connector_shared), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!connector.shared || admin) {
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.panels_connector_actions)) }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            if (admin) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(if (connector.shared) R.string.panels_connector_unshare else R.string.panels_connector_share)) },
                                    onClick = {
                                        menu = false
                                        if (connector.shared) panel.unshare(connector) else panel.share(connector)
                                    },
                                )
                            }
                            if (!connector.shared) {
                                DropdownMenuItem(text = { Text(stringResource(R.string.panels_remove)) }, onClick = {
                                    menu = false
                                    remove()
                                })
                            }
                        }
                    }
                }
            }
            if (connector.shared) Text(if (connector.alwaysFirst) stringResource(R.string.panels_connector_used_first, connector.useFor) else connector.useFor)
            if (connector.notes.isNotBlank()) {
                Text(
                    stringResource(R.string.panels_connector_learned, connector.notes),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (connector.shared) return@Column

            OutlinedTextField(
                value = useFor,
                onValueChange = { useFor = it },
                label = { Text(stringResource(R.string.panels_connector_use_for)) },
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.fillMaxWidth(),
            )
            FilledTonalButton(
                onClick = { panel.setUseFor(connector, useFor.trim()) },
                enabled = useFor.isNotBlank() && useFor.trim() != connector.useFor,
                shapes = ButtonDefaults.shapes(),
            ) { Text(stringResource(R.string.panels_save)) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.panels_connector_always_first))
                    Text(
                        stringResource(R.string.panels_connector_always_first_hint),
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
                    stringResource(
                        if (connector.hasKey) R.string.panels_connector_key_set else R.string.panels_connector_key_not_set,
                        auth.placement,
                        auth.name,
                    ),
                    style = MaterialTheme.typography.labelLarge,
                    color = if (connector.hasKey) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.tertiary,
                )
                // Typed without being shown, and cleared once sent: the key never comes back.
                OutlinedTextField(
                    value = key,
                    onValueChange = { key = it },
                    placeholder = { Text(stringResource(if (connector.hasKey) R.string.panels_connector_replace_key else R.string.panels_connector_paste_key)) },
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
                    ) { Text(stringResource(R.string.panels_connector_save_key)) }
                    if (connector.hasKey) {
                        OutlinedButton(onClick = { panel.clearKey(connector) }, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.panels_clear)) }
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.panels_connector_local))
                    Text(
                        stringResource(R.string.panels_connector_local_hint),
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
                stringResource(R.string.panels_connector_read_paths_hint),
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
            ) { Text(stringResource(R.string.panels_connector_save_read_paths)) }
        }
    }
}
