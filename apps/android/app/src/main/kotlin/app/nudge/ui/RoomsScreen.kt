package app.nudge.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.MeetingRoom
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FloatingActionButtonMenu
import androidx.compose.material3.FloatingActionButtonMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeFlexibleTopAppBar
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ToggleFloatingActionButton
import androidx.compose.material3.ToggleFloatingActionButtonDefaults.animateIcon
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.RoomRef
import app.nudge.Session
import app.nudge.explain
import kotlinx.coroutines.launch
import nudge.ffi.ConnectionStatus
import nudge.ffi.HomeRoom
import nudge.ffi.HomeUpdate
import nudge.ffi.MeInfo
import nudge.ffi.Room
import nudge.ffi.RoomKind
import nudge.ffi.SyncStatus

/** One signed-in assistant's rooms, newest news first, as the list shows them. */
private class Section(val session: Session, val home: HomeUpdate?, val me: MeInfo?, val connection: ConnectionStatus?) {
    val rooms = home?.view?.rooms.orEmpty().sortedByDescending { it.lastItemAt ?: 0.0 }
}

/**
 * The player's rooms at home, then those of each assistant they joined, a FAB menu for new rooms
 * at home, and a long press to rename one.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun RoomsScreen(
    session: Session,
    places: List<Session>,
    selected: RoomRef?,
    open: (RoomRef) -> Unit,
    settings: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val sections = (listOf(session) + places).map { at ->
        key(at.account.key) {
            Section(
                at,
                at.home.state.collectAsStateWithLifecycle().value,
                at.me.collectAsStateWithLifecycle().value,
                at.connection.state.collectAsStateWithLifecycle().value,
            )
        }
    }
    val home = sections.first()
    var menu by rememberSaveable { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<Pair<Session, Room>?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    BackHandler(menu) { menu = false }
    Scaffold(
        containerColor = groupedBackground(),
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            LargeFlexibleTopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(session.account.assistantName) },
                subtitle = connectionText(home.connection) ?: home.me?.player?.displayName?.let { name -> { Text(name) } },
                actions = {
                    IconButton(onClick = settings) { Icon(Icons.Outlined.Settings, "Settings") }
                },
                scrollBehavior = scrollBehavior,
            )
        },
        floatingActionButton = {
            FloatingActionButtonMenu(
                expanded = menu,
                button = {
                    ToggleFloatingActionButton(checked = menu, onCheckedChange = { menu = it }) {
                        val icon = if (checkedProgress > 0.5f) Icons.Filled.Close else Icons.Filled.Add
                        Icon(
                            rememberVectorPainter(icon),
                            contentDescription = if (menu) "Close" else "New room",
                            modifier = Modifier.animateIcon({ checkedProgress }),
                        )
                    }
                },
            ) {
                FloatingActionButtonMenuItem(
                    onClick = {
                        menu = false
                        scope.launch {
                            try {
                                open(RoomRef(session.account.key, session.client.personalRoom().id))
                            } catch (error: Exception) {
                                problem = explain(error)
                            }
                        }
                    },
                    text = { Text("My room") },
                    icon = { Icon(Icons.Outlined.Person, null) },
                )
                FloatingActionButtonMenuItem(
                    onClick = {
                        menu = false
                        creating = true
                    },
                    text = { Text("New shared room") },
                    icon = { Icon(Icons.Outlined.Group, null) },
                )
            }
        },
    ) { padding ->
        when {
            home.home?.view == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                LoadingIndicator()
            }
            home.home.status == SyncStatus.LIVE && sections.all { it.rooms.isEmpty() } -> Box(
                Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Text("No rooms yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> LazyColumn(
                contentPadding = PaddingValues(
                    start = 16.dp,
                    end = 16.dp,
                    top = padding.calculateTopPadding() + 8.dp,
                    bottom = padding.calculateBottomPadding() + 96.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(ListItemDefaults.SegmentedGap),
            ) {
                sections.forEachIndexed { at, section ->
                    val account = section.session.account
                    // The home's rooms come first, without a heading: the title names it.
                    if (at > 0) {
                        item(key = account.key) {
                            PlaceHeading(account.assistantName, java.net.URI(account.server).host, section.connection)
                        }
                    }
                    itemsIndexed(section.rooms, key = { _, room -> "${account.key}\u0000${room.room.id}" }) { index, room ->
                        val ref = RoomRef(account.key, room.room.id)
                        RoomRow(
                            room, section.me?.player?.id,
                            selected = ref == selected,
                            index = index,
                            count = section.rooms.size,
                            onClick = { open(ref) },
                            // Only admins rename the lobby.
                            rename = if (room.room.kind != RoomKind.LOBBY || section.me?.admin == true) {
                                { renaming = section.session to room.room }
                            } else {
                                null
                            },
                        )
                    }
                }
            }
        }
    }

    if (creating) {
        NewRoomDialog(session, close = { creating = false }, created = { open(RoomRef(session.account.key, it)) })
    }
    renaming?.let { (at, room) -> RenameRoomDialog(at, room, close = { renaming = null }) }
    problem?.let { message ->
        AlertDialog(
            onDismissRequest = { problem = null },
            title = { Text("Couldn't open the room") },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = { problem = null }) { Text("OK") } },
        )
    }
}

/** Above the rooms of an assistant the player joined: its name, its server, and whether it is offline. */
@Composable
private fun PlaceHeading(name: String, host: String?, connection: ConnectionStatus?) {
    androidx.compose.foundation.layout.Column(Modifier.padding(start = 4.dp, top = 20.dp, bottom = 6.dp)) {
        Text(name, style = MaterialTheme.typography.titleMedium)
        val status = connectionText(connection)
        androidx.compose.runtime.CompositionLocalProvider(
            androidx.compose.material3.LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant,
            androidx.compose.material3.LocalTextStyle provides MaterialTheme.typography.bodySmall,
        ) {
            if (status != null) status() else if (host != null) Text(host)
        }
    }
}

/** Shown under the title while the socket isn't open. */
private fun connectionText(status: ConnectionStatus?): (@Composable () -> Unit)? {
    val text = when (status) {
        is ConnectionStatus.Waiting -> "Offline · reconnecting"
        is ConnectionStatus.Connecting -> if (status.attempt > 0u) "Reconnecting…" else null
        is ConnectionStatus.Closed ->
            if (status.code.toInt() == 1000 || status.code.toInt() == 4401) null
            else status.reason.ifEmpty { "Disconnected (${status.code})" }
        else -> null
    } ?: return null
    return {
        androidx.compose.foundation.layout.Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.CloudOff, null, Modifier.size(16.dp))
            Text(text)
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun RoomRow(
    room: HomeRoom,
    me: String?,
    selected: Boolean,
    index: Int,
    count: Int,
    onClick: () -> Unit,
    rename: (() -> Unit)?,
) {
    val others = room.room.members.filter { it.id != me }.joinToString { it.displayName }
    var menu by remember { mutableStateOf(false) }
    Box {
        SegmentedListItem(
            selected = selected,
            onClick = onClick,
            onLongClick = rename?.let { { menu = true } },
            onLongClickLabel = rename?.let { "Room actions" },
            shapes = ListItemDefaults.segmentedShapes(index = index, count = count),
            leadingContent = {
                Icon(
                    when (room.room.kind) {
                        RoomKind.PERSONAL -> Icons.Outlined.Person
                        RoomKind.SHARED -> Icons.Outlined.Group
                        RoomKind.LOBBY -> Icons.Outlined.MeetingRoom
                    },
                    null,
                )
            },
            supportingContent = if (others.isEmpty()) null else ({ Text(others, maxLines = 1) }),
            trailingContent = {
                when {
                    room.pendingApprovals > 0u -> Badge(containerColor = MaterialTheme.colorScheme.tertiary) {
                        Text("${room.pendingApprovals}")
                    }
                    room.running -> LoadingIndicator(Modifier.size(28.dp))
                }
            },
        ) {
            Text(room.room.name, maxLines = 1)
        }
        if (rename != null) {
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text("Rename") },
                    leadingIcon = { Icon(Icons.Outlined.Edit, null) },
                    onClick = {
                        menu = false
                        rename()
                    },
                )
            }
        }
    }
}

@Composable
private fun NewRoomDialog(session: Session, close: () -> Unit, created: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = close,
        title = { Text("New shared room") },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Name") },
                singleLine = true,
                isError = problem != null,
                supportingText = problem?.let { { Text(it) } },
            )
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank(),
                onClick = {
                    scope.launch {
                        try {
                            created(session.client.createRoom(name.trim(), emptyList()).id)
                            close()
                        } catch (error: Exception) {
                            problem = explain(error)
                        }
                    }
                },
            ) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = close) { Text("Cancel") } },
    )
}

/** The room keeps its id; the list shows the new name once the home view has it. */
@Composable
private fun RenameRoomDialog(session: Session, room: Room, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember(room.id) { mutableStateOf(room.name) }
    var problem by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = close,
        title = { Text("Rename room") },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Name") },
                singleLine = true,
                isError = problem != null,
                supportingText = problem?.let { { Text(it) } },
            )
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && name.trim() != room.name,
                onClick = {
                    scope.launch {
                        try {
                            session.client.renameRoom(room.id, name.trim())
                            close()
                        } catch (error: Exception) {
                            problem = explain(error)
                        }
                    }
                },
            ) { Text("Rename") }
        },
        dismissButton = { TextButton(onClick = close) { Text("Cancel") } },
    )
}

@Composable
fun EmptyRoom() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Icon(Icons.Outlined.Forum, "Pick a room", Modifier.size(48.dp), tint = MaterialTheme.colorScheme.outline)
    }
}
