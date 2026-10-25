package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.AppModel
import app.nudge.R
import app.nudge.explain
import app.nudge.text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import nudge.ffi.NudgeException
import nudge.ffi.Reach
import nudge.ffi.WiredState
import nudge.ffi.WiredStatus

/**
 * A server's Wired: an encrypted network between the person's servers that needs no open port at
 * home. Home holds the network; a server with a public HTTPS address, such as one on exe.dev,
 * joins it and serves a relay there, through which they reach each other. A server too old for it
 * says so, with a check for the release that has it.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun WiredCard(model: AppModel, server: String) {
    val scope = rememberCoroutineScope()
    val client = remember(server) { model.servers.client(server) }
    var state by remember(server) { mutableStateOf<WiredState?>(null) }
    // Another owned server that holds a network this one can join, once looked up.
    var root by remember(server) { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    // Why the server can't run Wired, when it answered that it can't.
    var unsupported by remember(server) { mutableStateOf<String?>(null) }
    var turningOff by remember { mutableStateOf(false) }
    // The Wired name to make the home's address, while asking.
    var usingAddress by remember { mutableStateOf<String?>(null) }
    // The member to remove from the network, while asking.
    var removing by remember { mutableStateOf<String?>(null) }
    // The name this server takes in the network, as the owner typed it; the server's own until then.
    var name by remember(server) { mutableStateOf("") }
    val session by model.session.collectAsStateWithLifecycle()
    // Followed, so "Use as your home's address" goes once the home's address is its Wired one.
    val memberships by model.memberships.collectAsStateWithLifecycle()
    val starting = state?.state == WiredStatus.STARTING
    // Joining needs a public HTTPS address: the server serves its relay there.
    val isPublic = server.startsWith("https://")
    val isHome = session?.account?.server?.trimEnd('/') == server.trimEnd('/')
    val homeOnWired = remember(session, memberships) { model.homeReach() == Reach.WIRED }

    // The name the owner typed, or null to keep the server's own.
    val picked = name.trim().takeIf { it.isNotEmpty() && it != state?.name }
    val nameIsValid = picked?.let(::isWiredName) ?: true

    fun show(next: WiredState) {
        unsupported = null
        state = next
        problem = null
        if (next.state == WiredStatus.ROOT || next.state == WiredStatus.MEMBER) name = ""
    }

    fun act(action: suspend () -> WiredState) = scope.launch {
        busy = true
        try {
            show(action())
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            problem = explain(error)
        } finally {
            busy = false
        }
    }

    LaunchedEffect(server, starting) {
        suspend fun read() {
            try {
                show(client.wired())
                if (state?.state == WiredStatus.OFF || state?.state == WiredStatus.ERROR) {
                    root = model.servers.wiredRoot(except = server)
                }
            } catch (error: NudgeException.Status) {
                if (error.status.toInt() == 404) {
                    state = null
                    unsupported = text(R.string.servers_wired_older)
                } else {
                    problem = explain(error)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                problem = explain(error)
            }
        }
        read()
        // Until it is in, or it gave up.
        while (state?.state == WiredStatus.STARTING) {
            delay(2_000)
            read()
        }
    }

    if (turningOff) {
        AlertDialog(
            onDismissRequest = { turningOff = false },
            title = { Text(stringResource(R.string.servers_wired_off_title)) },
            text = {
                Text(
                    stringResource(
                        if (state?.state == WiredStatus.ROOT) R.string.servers_wired_off_root else R.string.servers_wired_off_member,
                    ),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    turningOff = false
                    act { client.disableWired() }
                }) { Text(stringResource(R.string.servers_wired_turn_off), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { turningOff = false }) { Text(stringResource(R.string.servers_cancel)) } },
        )
    }

    usingAddress?.let { name ->
        AlertDialog(
            onDismissRequest = { usingAddress = null },
            title = { Text(stringResource(R.string.servers_wired_use_title, name)) },
            text = {
                Text(stringResource(R.string.servers_wired_use_body))
            },
            confirmButton = {
                TextButton(onClick = {
                    usingAddress = null
                    busy = true
                    scope.launch {
                        try {
                            model.useWiredAddress(name)
                            problem = null
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            problem = explain(error)
                        } finally {
                            busy = false
                        }
                    }
                }) { Text(stringResource(R.string.servers_wired_use_it)) }
            },
            dismissButton = { TextButton(onClick = { usingAddress = null }) { Text(stringResource(R.string.servers_cancel)) } },
        )
    }

    removing?.let { member ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(R.string.servers_wired_remove_title, member)) },
            text = {
                Text(stringResource(R.string.servers_wired_remove_body))
            },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    act { client.removeWiredMember(member) }
                }) { Text(stringResource(R.string.servers_remove), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.servers_cancel)) } },
        )
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Section(stringResource(R.string.servers_wired))
        Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.large) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val current = state
                val why = unsupported
                when {
                    why != null -> {
                        Text(why, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(
                            enabled = !busy,
                            onClick = {
                                // A newer release is installed and restarted into when updates are automatic.
                                busy = true
                                scope.launch {
                                    try {
                                        val updates = client.checkUpdates()
                                        problem = updates.error
                                            ?: updates.available?.let { text(R.string.servers_wired_installing, it) }
                                            ?: text(R.string.servers_wired_no_newer)
                                    } catch (error: CancellationException) {
                                        throw error
                                    } catch (error: Exception) {
                                        problem = explain(error)
                                    } finally {
                                        busy = false
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(stringResource(if (busy) R.string.servers_wired_checking else R.string.servers_wired_check_updates)) }
                    }
                    // Not read yet, or reading it failed: the problem below says why.
                    current == null -> if (problem == null) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            LoadingIndicator()
                            Text(stringResource(R.string.servers_wired_checking_wired), Modifier.padding(start = 12.dp))
                        }
                    }
                    else -> when (current.state) {
                        WiredStatus.OFF, WiredStatus.ERROR -> {
                            if (current.state == WiredStatus.ERROR) {
                                Text(current.error ?: stringResource(R.string.servers_wired_stopped), color = MaterialTheme.colorScheme.onSurfaceVariant)
                                OutlinedButton(onClick = { turningOff = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                                    Text(stringResource(R.string.servers_wired_turn_off_wired), color = MaterialTheme.colorScheme.error)
                                }
                            }
                            val invalid = picked != null && !nameIsValid
                            OutlinedTextField(
                                value = name,
                                onValueChange = { name = it },
                                label = { Text(stringResource(R.string.servers_name)) },
                                placeholder = { Text(current.name ?: "box") },
                                singleLine = true,
                                isError = invalid,
                                supportingText = {
                                    Text(
                                        if (invalid) {
                                            stringResource(R.string.servers_wired_name_invalid)
                                        } else {
                                            stringResource(R.string.servers_wired_reach_at, picked ?: current.name ?: "box")
                                        },
                                    )
                                },
                                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                                shape = MaterialTheme.shapes.large,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            val holder = root
                            if (holder != null && isPublic) {
                                // Home lists this server's relay and this server joins with home's invite, which stays in the app.
                                Button(
                                    onClick = { act { model.servers.client(holder).connectWired(client, server, picked) } },
                                    enabled = !busy && nameIsValid,
                                    modifier = Modifier.fillMaxWidth(),
                                ) { Text(stringResource(R.string.servers_wired_join, java.net.URI(holder).host ?: holder)) }
                            }
                            OutlinedButton(
                                onClick = { act { client.enableWired(picked) } },
                                enabled = !busy && nameIsValid,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(stringResource(R.string.servers_wired_hold))
                            }
                            if (holder == null && isPublic) {
                                Text(
                                    stringResource(R.string.servers_wired_or_join),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        WiredStatus.UNAVAILABLE ->
                            Text(stringResource(R.string.servers_wired_no_release), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        WiredStatus.STARTING -> Row(verticalAlignment = Alignment.CenterVertically) {
                            LoadingIndicator()
                            Text(stringResource(R.string.servers_wired_starting), Modifier.padding(start = 12.dp))
                        }
                        WiredStatus.ROOT, WiredStatus.MEMBER -> {
                            val me = current.name ?: stringResource(R.string.servers_wired_this_server)
                            Text(
                                stringResource(if (current.state == WiredStatus.ROOT) R.string.servers_wired_holds_as else R.string.servers_wired_in_as, me),
                                color = MaterialTheme.colorScheme.primary,
                            )
                            current.members.filter { it.name != current.name }.forEach { member ->
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                    Text(if (member.anchor) stringResource(R.string.servers_wired_member_holds, member.name) else member.name, Modifier.weight(1f))
                                    if (current.state == WiredStatus.ROOT) {
                                        TextButton(onClick = { removing = member.name }, enabled = !busy) {
                                            Text(stringResource(R.string.servers_remove), color = MaterialTheme.colorScheme.error)
                                        }
                                    }
                                }
                            }
                            if (current.state == WiredStatus.ROOT && current.members.size > 1) {
                                Text(
                                    stringResource(R.string.servers_wired_remove_hint),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (current.state == WiredStatus.ROOT && current.relays.isEmpty()) {
                                Text(
                                    stringResource(R.string.servers_wired_no_relays),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            current.name?.let { name ->
                                SelectionContainer {
                                    Text(
                                        stringResource(R.string.servers_wired_reach_at, name),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                if (isHome && !homeOnWired) {
                                    OutlinedButton(onClick = { usingAddress = name }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                                        Text(stringResource(R.string.servers_wired_use_address))
                                    }
                                }
                            }
                            OutlinedButton(onClick = { turningOff = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                                Text(stringResource(R.string.servers_wired_turn_off_wired), color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
                problem?.let {
                    Text(it, color = if (unsupported == null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    stringResource(R.string.servers_wired_explainer),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * A name Wired accepts as it is: 1–63 lowercase letters, digits and dashes, not starting or ending
 * with a dash.
 */
internal fun isWiredName(name: String): Boolean = WIRED_NAME.matches(name)

private val WIRED_NAME = Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
