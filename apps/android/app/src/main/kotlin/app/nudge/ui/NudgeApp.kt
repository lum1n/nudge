package app.nudge.ui

import androidx.compose.runtime.CompositionLocalProvider
import app.nudge.avatar.LocalRobotLook
import app.nudge.avatar.look
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
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.AppModel
import app.nudge.R
import app.nudge.RoomRef
import app.nudge.Session
import app.nudge.explain
import app.nudge.hostOf
import app.nudge.text
import kotlinx.coroutines.launch
import nudge.ffi.ConnectionStatus

/** What a device without an account shows: signing in, setting a server up, or making one. */
private sealed interface SignedOut {
    data object SignIn : SignedOut
    data class Setup(val start: SetupStart) : SignedOut
    data object Exe : SignedOut
}

/** Sign-in, or setting a server up, until there is an account; then the rooms. */
@Composable
fun NudgeApp(model: AppModel, askForNotifications: () -> Unit) {
    val session by model.session.collectAsStateWithLifecycle()
    var signedOut by remember { mutableStateOf<SignedOut>(SignedOut.SignIn) }
    val current = session
    if (current != null) {
        SignedIn(model, current)
        return
    }
    when (val screen = signedOut) {
        SignedOut.SignIn -> SignInScreen(
            model, askForNotifications,
            setUp = { signedOut = SignedOut.Setup(SetupStart()) },
            exe = { signedOut = SignedOut.Exe },
        )
        is SignedOut.Setup -> SetupScreen(model, screen.start, close = { signedOut = SignedOut.SignIn })
        SignedOut.Exe -> ExeScreen(
            model,
            close = { signedOut = SignedOut.SignIn },
            ready = { signedOut = SignedOut.Setup(it) },
        )
    }
}

/**
 * What the detail and extra panes show: a room of one of the signed-in assistants, and in the
 * extra pane its lists, its details, its documents, its connectors, its MCP servers, its browser or
 * its desktop.
 */
private data class Destination(val account: String, val room: String, val extra: Extra? = null) {
    val ref get() = RoomRef(account, room)

    // Kept as a string: the navigator saves its history.
    fun key(): String = listOfNotNull(account, room, extra?.name).joinToString("\u0000")

    companion object {
        fun of(key: String?): Destination? {
            val parts = key?.split('\u0000') ?: return null
            if (parts.size < 2) return null
            return Destination(parts[0], parts[1], parts.getOrNull(2)?.let(Extra::valueOf))
        }

        fun of(ref: RoomRef, extra: Extra? = null) = Destination(ref.account, ref.room, extra)
    }
}

private enum class Extra { LISTS, INFO, DOCUMENTS, CONNECTORS, MCP, BROWSER, DESKTOP }

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
    val join by model.pendingJoin.collectAsStateWithLifecycle()
    val signIn by model.pendingSignIn.collectAsStateWithLifecycle()
    val places by model.places.collectAsStateWithLifecycle()
    var settings by rememberSaveable { mutableStateOf(false) }
    val navigator = rememberListDetailPaneScaffoldNavigator<String>()
    val shown = Destination.of(navigator.currentDestination?.contentKey)
    val listVisible = navigator.scaffoldValue[ListDetailPaneScaffoldRole.List] != PaneAdaptedValue.Hidden

    // The token was revoked or is unknown: nothing will work until signing in again.
    LaunchedEffect(connection) {
        val status = connection
        if (status is ConnectionStatus.Closed && status.code.toInt() == 4401) {
            model.signOut(text(R.string.room_signed_out_device))
        }
    }
    // A tapped notification picks a room; the scaffold's own navigation tells the model which is open.
    LaunchedEffect(requested) {
        val room = requested ?: return@LaunchedEffect
        if (shown?.ref != room) navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, Destination.of(room).key())
        model.requestedRoom.value = null
    }
    LaunchedEffect(shown?.ref) { model.selectedRoom.value = shown?.ref }

    link?.let { pairing ->
        AlertDialog(
            onDismissRequest = { model.pendingLink.value = null },
            title = { Text(stringResource(R.string.room_link_title)) },
            text = {
                Text(
                    stringResource(R.string.room_link_body, pairing.assistant, pairing.server, session.account.assistantName),
                )
            },
            confirmButton = { TextButton(onClick = { scope.launch { model.signOut() } }) { Text(stringResource(R.string.room_sign_out)) } },
            dismissButton = { TextButton(onClick = { model.pendingLink.value = null }) { Text(stringResource(R.string.room_cancel)) } },
        )
    }

    join?.let { invite -> JoinDialog(model, session, invite) }
    signIn?.let { browser -> SignInDialog(model, browser) }

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
                    session, places,
                    selected = if (listVisible && navigator.scaffoldValue[ListDetailPaneScaffoldRole.Detail] != PaneAdaptedValue.Hidden) shown?.ref else null,
                    open = { open(Destination.of(it)) },
                    settings = { settings = true },
                )
            }
        },
        detailPane = {
            AnimatedPane {
                val room = shown?.ref
                val at = room?.let { model.sessionFor(it.account) }
                if (room == null || at == null) {
                    EmptyRoom()
                } else {
                    CompositionLocalProvider(LocalRobotLook provides at.look()) {
                        RoomScreen(
                            at, room.room, model.dictation,
                            back = if (listVisible) null else ({ scope.launch { navigator.navigateBack() } }),
                            lists = { open(Destination.of(room, Extra.LISTS)) },
                            info = { open(Destination.of(room, Extra.INFO)) },
                            browser = { open(Destination.of(room, Extra.BROWSER)) },
                        )
                    }
                }
            }
        },
        // Only while something is open there: on a wide screen an empty third pane still takes room.
        extraPane = shown?.extra?.let { extra ->
            val at = model.sessionFor(shown.account) ?: return@let null
            val client = at.client
            {
                AnimatedPane {
                    val close = { scope.launch { navigator.navigateBack() }; Unit }
                    val room = shown.ref
                    when (extra) {
                        Extra.LISTS -> ListsScreen(client, room.room, close)
                        Extra.INFO -> RoomInfoScreen(
                            client, room.room, close,
                            documents = { open(Destination.of(room, Extra.DOCUMENTS)) },
                            connectors = { open(Destination.of(room, Extra.CONNECTORS)) },
                            mcp = { open(Destination.of(room, Extra.MCP)) },
                            browser = { open(Destination.of(room, Extra.BROWSER)) },
                            desktop = { open(Destination.of(room, Extra.DESKTOP)) },
                        )
                        Extra.DOCUMENTS -> DocumentsScreen(client, room.room, close)
                        Extra.CONNECTORS -> ConnectorsScreen(client, room.room, close)
                        Extra.MCP -> McpServersScreen(client, room.room, at.account.server, close)
                        Extra.BROWSER -> BrowserScreen(client, room.room, close)
                        Extra.DESKTOP -> DesktopScreen(client, room.room, close)
                    }
                }
            }
        },
    )
}

/** An admin of another assistant invited the player: join it, the home vouching for them. */
@Composable
private fun JoinDialog(model: AppModel, session: Session, invite: nudge.client.JoinLink) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val close = { model.pendingJoin.value = null }
    AlertDialog(
        onDismissRequest = { if (!busy) close() },
        title = { Text(stringResource(R.string.room_join_title, invite.assistant)) },
        text = {
            Text(
                problem ?: stringResource(
                    R.string.room_join_body,
                    session.account.assistantName, invite.assistant, "${java.net.URI(invite.server).host}",
                ),
            )
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = {
                    busy = true
                    scope.launch {
                        try {
                            model.join(invite)
                            close()
                        } catch (error: Exception) {
                            problem = explain(error)
                        } finally {
                            busy = false
                        }
                    }
                },
            ) { Text(stringResource(if (problem == null) R.string.room_join else R.string.room_try_again)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = close) { Text(stringResource(R.string.room_cancel)) } },
    )
}

/** The web UI's sign-in page showed a QR code: sign that browser in as the player. */
@Composable
private fun SignInDialog(model: AppModel, browser: nudge.client.SignInLink) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var signedIn by remember { mutableStateOf<String?>(null) }
    val close = { model.pendingSignIn.value = null }
    AlertDialog(
        onDismissRequest = { if (!busy) close() },
        title = { Text(stringResource(if (signedIn == null) R.string.room_web_sign_in_title else R.string.room_web_signed_in)) },
        text = {
            Text(
                signedIn?.let { stringResource(R.string.room_web_signed_in_body, it) }
                    ?: problem
                    ?: stringResource(R.string.room_web_sign_in_body, "${hostOf(browser.server)}"),
            )
        },
        confirmButton = {
            if (signedIn != null) {
                TextButton(onClick = close) { Text(stringResource(R.string.room_done)) }
            } else {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        busy = true
                        scope.launch {
                            try {
                                signedIn = model.approveSignIn(browser)
                            } catch (error: Exception) {
                                problem = explain(error)
                            } finally {
                                busy = false
                            }
                        }
                    },
                ) { Text(stringResource(if (problem == null) R.string.room_sign_in else R.string.room_try_again)) }
            }
        },
        dismissButton = {
            if (signedIn == null) TextButton(enabled = !busy, onClick = close) { Text(stringResource(R.string.room_cancel)) }
        },
    )
}
