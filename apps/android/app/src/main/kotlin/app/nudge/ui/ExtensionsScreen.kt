package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
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
import app.nudge.explain
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import nudge.client.saved
import nudge.client.settingFields
import nudge.client.settings
import nudge.ffi.ExtensionSetup
import nudge.ffi.NudgeClient
import nudge.ffi.NudgeException
import nudge.ffi.RoomKind

/** One extension as the screen edits it, before it is saved. */
private data class Draft(val enabled: Boolean, val settings: JsonObject, val rooms: List<RoomKind>?)

private fun draftOf(setup: ExtensionSetup) = Draft(setup.enabled, setup.settings, setup.rooms)

private val KINDS = listOf(RoomKind.LOBBY to "Everyone", RoomKind.PERSONAL to "Personal", RoomKind.SHARED to "Shared")

/**
 * The assistant's extensions, set up by an admin: on or off, their settings and the rooms they
 * are on in. Saving installs them again on the server and writes its nudge.json; if one fails to
 * start, nothing changes.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ExtensionsScreen(client: NudgeClient, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var setups by remember { mutableStateOf<List<ExtensionSetup>?>(null) }
    var drafts by remember { mutableStateOf<Map<String, Draft>>(emptyMap()) }
    var loadProblem by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }

    fun show(next: List<ExtensionSetup>) {
        setups = next
        drafts = next.associate { it.from to draftOf(it) }
    }

    LaunchedEffect(client) {
        try {
            show(client.extensionSetups())
        } catch (error: Exception) {
            loadProblem = if (error is NudgeException.Status && error.status.toInt() == 404) {
                "This server can't set up extensions from the app. Run it with nudge serve."
            } else {
                explain(error)
            }
        }
    }

    val all = setups
    val dirty = all != null && all.any { drafts[it.from] != draftOf(it) }

    fun save() {
        val current = setups ?: return
        saving = true
        problem = null
        scope.launch {
            try {
                val next = client.saveExtensionSetups(
                    current
                        // One found beside the config is only added once it is turned on.
                        .filter { drafts[it.from]?.enabled == true || it.configured }
                        .map { setup ->
                            val draft = drafts.getValue(setup.from)
                            setup.saved(draft.enabled, draft.settings, draft.rooms)
                        },
                )
                show(next)
                saved = true
            } catch (error: Exception) {
                problem = explain(error)
            } finally {
                saving = false
            }
        }
    }

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text("Extensions") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
        bottomBar = {
            if (dirty || problem != null || saved) {
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                    Row(
                        Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            problem ?: if (dirty) "Unsaved changes" else "Saved and installed.",
                            Modifier.weight(1f),
                            color = if (problem != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                        )
                        if (dirty) {
                            OutlinedButton(
                                onClick = {
                                    problem = null
                                    all?.let(::show)
                                },
                                enabled = !saving,
                                shapes = ButtonDefaults.shapes(),
                            ) { Text("Discard") }
                            Button(onClick = ::save, enabled = !saving, shapes = ButtonDefaults.shapes()) {
                                Text(if (saving) "Saving…" else "Save")
                            }
                        }
                    }
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            when {
                loadProblem != null -> Text(
                    loadProblem!!,
                    Modifier.align(Alignment.Center).padding(32.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                all == null -> LoadingIndicator(Modifier.align(Alignment.Center))
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item {
                        Text(
                            "What the assistant can do beyond talking. Saving installs them again right away and writes " +
                                "them to the server's nudge.json; if one fails to start, nothing changes. Each room can " +
                                "still turn them on or off for itself.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                    val (added, available) = all.partition { it.configured }
                    if (added.isNotEmpty()) item { Section("Added") }
                    items(added, key = { it.from }) { setup ->
                        ExtensionCard(setup, drafts.getValue(setup.from)) { change ->
                            saved = false
                            drafts = drafts + (setup.from to change)
                        }
                    }
                    if (available.isNotEmpty()) item { Section("Not added yet") }
                    items(available, key = { it.from }) { setup ->
                        ExtensionCard(setup, drafts.getValue(setup.from)) { change ->
                            saved = false
                            drafts = drafts + (setup.from to change)
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ExtensionCard(setup: ExtensionSetup, draft: Draft, onChange: (Draft) -> Unit) {
    var open by rememberSaveable(setup.from) { mutableStateOf(false) }
    val fields = remember(setup.schemaJson) { settingFields(setup.schemaJson) }
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(setup.name ?: setup.from, style = MaterialTheme.typography.titleMedium)
                        setup.version?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    setup.description?.let {
                        Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Switch(
                    checked = draft.enabled,
                    onCheckedChange = { onChange(draft.copy(enabled = it)) },
                    enabled = setup.error == null,
                )
            }
            setup.error?.let { Text("Couldn't load it: $it", color = MaterialTheme.colorScheme.error) }
            if (setup.missingEnv.isNotEmpty()) {
                Text(
                    "Needs ${setup.missingEnv.joinToString { "\$$it" }} in the server's environment, or the value in its " +
                        "settings, before it can start.",
                    color = MaterialTheme.colorScheme.tertiary,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (fields.isNotEmpty() || setup.error == null) {
                TextButton(onClick = { open = !open }) {
                    Text(if (open) "Hide settings" else if (fields.isNotEmpty()) "Settings" else "Rooms")
                }
            }
            if (open) {
                if (fields.isNotEmpty()) {
                    SettingFields(fields, draft.settings) { onChange(draft.copy(settings = it)) }
                }
                Text("On by default in", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val rooms = draft.rooms ?: KINDS.map { it.first }
                    KINDS.forEach { (kind, label) ->
                        FilterChip(
                            selected = kind in rooms,
                            onClick = {
                                val next = if (kind in rooms) rooms - kind else KINDS.map { it.first }.filter { it == kind || it in rooms }
                                onChange(draft.copy(rooms = if (next.size == KINDS.size) null else next))
                            },
                            label = { Text(label) },
                        )
                    }
                }
                Text(
                    "People in a room can still turn it on or off there.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
