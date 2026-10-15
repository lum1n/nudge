package app.nudge.ui

import androidx.activity.compose.BackHandler
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.layout.PaneAdaptedValue
import androidx.compose.material3.adaptive.navigation.NavigableListDetailPaneScaffold
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.AppModel
import app.nudge.Session
import kotlinx.coroutines.launch
import nudge.ffi.ConnectionStatus

/** Sign-in until there is an account; then the rooms. */
@Composable
fun NudgeApp(model: AppModel, askForNotifications: () -> Unit) {
    val session by model.session.collectAsStateWithLifecycle()
    val current = session
    if (current == null) {
        SignInScreen(model, askForNotifications)
    } else {
        SignedIn(model, current)
    }
}

/** What the detail and extra panes show: a room, and in the extra pane its lists or its details. */
private data class Destination(val room: String, val extra: Extra? = null) {
    // Kept as a string: the navigator saves its history.
    fun key(): String = if (extra == null) room else "$room\u0000${extra.name}"

    companion object {
        fun of(key: String?): Destination? {
            key ?: return null
            val parts = key.split('\u0000', limit = 2)
            return Destination(parts[0], parts.getOrNull(1)?.let(Extra::valueOf))
        }
    }
}

private enum class Extra { LISTS, INFO }

/**
 * The rooms beside the open room, the Android way: one pane on a phone, list and detail side by
 * side on a tablet or an unfolded foldable, with predictive back between them. A room's lists and
 * details open in the third pane.
 */
@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
private fun SignedIn(model: AppModel, session: Session) {
    val scope = rememberCoroutineScope()
    val connection by session.connection.state.collectAsStateWithLifecycle()
    val requested by model.requestedRoom.collectAsStateWithLifecycle()
    val link by model.pendingLink.collectAsStateWithLifecycle()
    var settings by rememberSaveable { mutableStateOf(false) }
    val navigator = rememberListDetailPaneScaffoldNavigator<String>()
    val shown = Destination.of(navigator.currentDestination?.contentKey)
    val listVisible = navigator.scaffoldValue[ListDetailPaneScaffoldRole.List] != PaneAdaptedValue.Hidden

    // The token was revoked or is unknown: nothing will work until signing in again.
    LaunchedEffect(connection) {
        val status = connection
        if (status is ConnectionStatus.Closed && status.code.toInt() == 4401) {
            model.signOut("This device was signed out. Ask for a new pairing code.")
        }
    }
    // A tapped notification picks a room; the scaffold's own navigation tells the model which is open.
    LaunchedEffect(requested) {
        val room = requested ?: return@LaunchedEffect
        if (shown?.room != room) navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, Destination(room).key())
        model.requestedRoom.value = null
    }
    LaunchedEffect(shown?.room) { model.selectedRoom.value = shown?.room }

    link?.let { pairing ->
        AlertDialog(
            onDismissRequest = { model.pendingLink.value = null },
            title = { Text("Sign in with link?") },
            text = {
                Text(
                    "To use the link for ${pairing.assistant} on ${pairing.server}, this device signs out of " +
                        "${session.account.assistantName} first.",
                )
            },
            confirmButton = { TextButton(onClick = { scope.launch { model.signOut() } }) { Text("Sign out") } },
            dismissButton = { TextButton(onClick = { model.pendingLink.value = null }) { Text("Cancel") } },
        )
    }

    if (settings) {
        BackHandler { settings = false }
        SettingsScreen(model, session, close = { settings = false })
        return
    }

    fun open(destination: Destination) {
        val pane = if (destination.extra == null) ListDetailPaneScaffoldRole.Detail else ListDetailPaneScaffoldRole.Extra
        scope.launch { navigator.navigateTo(pane, destination.key()) }
    }

    NavigableListDetailPaneScaffold(
        navigator = navigator,
        listPane = {
            AnimatedPane {
                RoomsScreen(
                    model, session,
                    selected = if (listVisible && navigator.scaffoldValue[ListDetailPaneScaffoldRole.Detail] != PaneAdaptedValue.Hidden) shown?.room else null,
                    open = { open(Destination(it)) },
                    settings = { settings = true },
                )
            }
        },
        detailPane = {
            AnimatedPane {
                val room = shown?.room
                if (room == null) {
                    EmptyRoom()
                } else {
                    RoomScreen(
                        session.client, room, model,
                        back = if (listVisible) null else ({ scope.launch { navigator.navigateBack() } }),
                        lists = { open(Destination(room, Extra.LISTS)) },
                        info = { open(Destination(room, Extra.INFO)) },
                    )
                }
            }
        },
        // Only while something is open there: on a wide screen an empty third pane still takes room.
        extraPane = shown?.extra?.let { extra ->
            {
                AnimatedPane {
                    val close = { scope.launch { navigator.navigateBack() }; Unit }
                    when (extra) {
                        Extra.LISTS -> ListsScreen(session.client, shown.room, close)
                        Extra.INFO -> RoomInfoScreen(session.client, shown.room, close)
                    }
                }
            }
        },
    )
}
