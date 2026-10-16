package app.nudge.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Api
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.explain
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import nudge.client.ObservedRoom
import nudge.client.observeRoomState
import nudge.ffi.ModelMessage
import nudge.ffi.ModelRole
import nudge.ffi.NudgeClient
import nudge.ffi.RoomExtension

/**
 * About a room: its documents and connectors, who is in it, what the assistant remembers
 * here, its nudges, which extensions it uses, and what the model saw. Opens in the third pane, or full screen on a phone.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun RoomInfoScreen(
    client: NudgeClient,
    roomId: String,
    close: () -> Unit,
    documents: () -> Unit,
    connectors: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val observed = remember(client, roomId) { MutableStateFlow<ObservedRoom?>(null) }
    DisposableEffect(client, roomId) {
        val room = client.observeRoomState(roomId)
        observed.value = room
        onDispose { room.close() }
    }
    val room by observed.collectAsStateWithLifecycle()
    val state = room?.state?.collectAsStateWithLifecycle()?.value
    var extensions by remember { mutableStateOf<List<RoomExtension>?>(null) }
    var modelView by remember { mutableStateOf<List<ModelMessage>?>(null) }
    var newFact by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }

    fun run(action: suspend () -> Unit) = scope.launch {
        try {
            action()
            problem = null
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    LaunchedEffect(roomId) { run { extensions = client.roomExtensions(roomId) } }

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text("About this room") },
                subtitle = { Text(state?.room?.name ?: "") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, "Close") } },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.imePadding(),
            contentPadding = PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = padding.calculateTopPadding(),
                bottom = padding.calculateBottomPadding() + 24.dp,
            ),
        ) {
            problem?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }

            // Holds the list at its top when the panels below come in later.
            item(key = "top") {}
            // The panels of the extensions the room has on.
            val on = extensions.orEmpty().filter { it.enabled }.map { it.name }.toSet()
            val panels: List<GroupRow> = listOf(
                Triple("documents", "Documents", Icons.Outlined.Description to documents),
                Triple("connectors", "Connectors", Icons.Outlined.Api to connectors),
            ).filter { it.first in on }.map { (_, title, action) ->
                { shapes ->
                    SegmentedListItem(
                        onClick = action.second,
                        shapes = shapes,
                        leadingContent = { Icon(action.first, null) },
                        trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                    ) { Text(title) }
                }
            }
            if (panels.isNotEmpty()) group("In this room", panels)

            group(
                "Members",
                state?.room?.members.orEmpty().map { member ->
                    { shapes ->
                        SegmentedListItem(shapes = shapes, leadingContent = { Icon(Icons.Outlined.Person, null) }) {
                            Text(member.displayName)
                        }
                    }
                },
            )

            group(
                "Memory",
                state?.memory.orEmpty().map { fact ->
                    { shapes ->
                        SegmentedListItem(
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Psychology, null) },
                            supportingContent = (fact.owner?.let { "${it.displayName}'s own" }
                                ?: fact.by?.let { "Added by ${it.displayName}" })?.let { { Text(it) } },
                            trailingContent = {
                                IconButton(onClick = { run { client.forget(roomId, fact.id) } }) {
                                    Icon(Icons.Outlined.Close, "Forget")
                                }
                            },
                        ) { Text(fact.text) }
                    }
                },
            )
            item {
                OutlinedTextField(
                    value = newFact,
                    onValueChange = { newFact = it },
                    placeholder = { Text("Remember in this room…") },
                    singleLine = true,
                    shape = MaterialTheme.shapes.large,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        val text = newFact.trim()
                        if (text.isNotEmpty()) {
                            newFact = ""
                            run { client.remember(roomId, text) }
                        }
                    }),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
            }

            val nudges = state?.nudges.orEmpty()
            if (nudges.isNotEmpty()) {
                group(
                    "Nudges",
                    nudges.map { nudge ->
                        { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.NotificationsActive, null) },
                                supportingContent = {
                                    Text(DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(nudge.fireAt.toLong())))
                                },
                                trailingContent = {
                                    TextButton(onClick = { run { client.cancelNudge(nudge.id) } }) { Text("Cancel") }
                                },
                            ) { Text(nudge.message) }
                        }
                    },
                )
            }

            group(
                "Extensions",
                extensions.orEmpty().map { ext ->
                    { shapes ->
                        SegmentedListItem(
                            checked = ext.enabled,
                            onCheckedChange = { enabled ->
                                run {
                                    val changed = client.setRoomExtension(roomId, ext.name, enabled)
                                    extensions = extensions?.map { if (it.name == changed.name) changed else it }
                                }
                            },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Extension, null) },
                            supportingContent = ext.description?.let { { Text(it) } },
                            trailingContent = { Switch(checked = ext.enabled, onCheckedChange = null) },
                        ) { Text(ext.name) }
                    }
                },
            )

            val shown = modelView
            group(
                "What the model saw",
                shown?.map { message ->
                    { shapes ->
                        SegmentedListItem(
                            shapes = shapes,
                            overlineContent = {
                                Text(
                                    when (message.role) {
                                        ModelRole.SYSTEM -> "System"
                                        ModelRole.USER -> "Messages"
                                        ModelRole.ASSISTANT -> "Assistant"
                                        ModelRole.TOOL_RESULT -> "Tool result"
                                    },
                                )
                            },
                        ) { Text(message.text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                    }
                } ?: emptyList(),
            )
            if (shown == null) {
                item {
                    FilledTonalButton(
                        onClick = { run { modelView = client.modelView(roomId) } },
                        shapes = ButtonDefaults.shapes(),
                    ) {
                        Icon(Icons.Outlined.Visibility, null, Modifier.padding(end = 8.dp))
                        Text("Show")
                    }
                }
            }
        }
    }
}
