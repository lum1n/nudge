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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.AppModel
import app.nudge.explain
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
                    unsupported = "This server's Nudge is older than Wired. It installs new releases itself; check for one now."
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
            title = { Text("Turn off Wired here?") },
            text = {
                Text(
                    if (state?.state == WiredStatus.ROOT) {
                        "Your servers stop reaching each other through this network."
                    } else {
                        "This server leaves the network, and stops reaching your other servers through it."
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    turningOff = false
                    act { client.disableWired() }
                }) { Text("Turn off", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { turningOff = false }) { Text("Cancel") } },
        )
    }

    usingAddress?.let { name ->
        AlertDialog(
            onDismissRequest = { usingAddress = null },
            title = { Text("Use http://nudge.$name.wired as your home's address?") },
            text = {
                Text(
                    "Your other servers then reach your home over Wired. Your home's address is " +
                        "who it is to other assistants: the ones you joined from home have to be joined again.",
                )
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
                }) { Text("Use it") }
            },
            dismissButton = { TextButton(onClick = { usingAddress = null }) { Text("Cancel") } },
        )
    }

    removing?.let { member ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove $member from the network?") },
            text = {
                Text("It no longer reaches your servers over Wired, and can't join again with its key. A new server can then use the name.")
            },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    act { client.removeWiredMember(member) }
                }) { Text("Remove", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Section("Wired")
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
                                            ?: updates.available?.let { "Installing $it. The server restarts in a minute; come back then." }
                                            ?: "No newer release yet."
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
                        ) { Text(if (busy) "Checking…" else "Check for updates") }
                    }
                    // Not read yet, or reading it failed: the problem below says why.
                    current == null -> if (problem == null) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            LoadingIndicator()
                            Text("Checking Wired…", Modifier.padding(start = 12.dp))
                        }
                    }
                    else -> when (current.state) {
                        WiredStatus.OFF, WiredStatus.ERROR -> {
                            if (current.state == WiredStatus.ERROR) {
                                Text(current.error ?: "Wired stopped.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                OutlinedButton(onClick = { turningOff = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                                    Text("Turn off Wired", color = MaterialTheme.colorScheme.error)
                                }
                            }
                            val invalid = picked != null && !nameIsValid
                            OutlinedTextField(
                                value = name,
                                onValueChange = { name = it },
                                label = { Text("Name") },
                                placeholder = { Text(current.name ?: "box") },
                                singleLine = true,
                                isError = invalid,
                                supportingText = {
                                    Text(
                                        if (invalid) {
                                            "Lowercase letters, digits and dashes, such as box."
                                        } else {
                                            "Others reach it at http://nudge.${picked ?: current.name ?: "box"}.wired"
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
                                ) { Text("Join ${java.net.URI(holder).host ?: holder}'s network") }
                            }
                            OutlinedButton(
                                onClick = { act { client.enableWired(picked) } },
                                enabled = !busy && nameIsValid,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text("Hold a network here")
                            }
                            if (holder == null && isPublic) {
                                Text(
                                    "Or join one: hold a network on your home server first, then come back here.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        WiredStatus.UNAVAILABLE ->
                            Text("This server's release has no Wired.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        WiredStatus.STARTING -> Row(verticalAlignment = Alignment.CenterVertically) {
                            LoadingIndicator()
                            Text("Starting Wired…", Modifier.padding(start = 12.dp))
                        }
                        WiredStatus.ROOT, WiredStatus.MEMBER -> {
                            val me = current.name ?: "this server"
                            Text(
                                if (current.state == WiredStatus.ROOT) "Holds the network as $me" else "In the network as $me",
                                color = MaterialTheme.colorScheme.primary,
                            )
                            current.members.filter { it.name != current.name }.forEach { member ->
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                    Text(if (member.anchor) "${member.name} (holds it)" else member.name, Modifier.weight(1f))
                                    if (current.state == WiredStatus.ROOT) {
                                        TextButton(onClick = { removing = member.name }, enabled = !busy) {
                                            Text("Remove", color = MaterialTheme.colorScheme.error)
                                        }
                                    }
                                }
                            }
                            if (current.state == WiredStatus.ROOT && current.members.size > 1) {
                                Text(
                                    "Remove a server from the network when it's gone: a new server can then take its name.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (current.state == WiredStatus.ROOT && current.relays.isEmpty()) {
                                Text(
                                    "No server with a public address has joined yet: open one of them here and join this network.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            current.name?.let { name ->
                                SelectionContainer {
                                    Text(
                                        "Others reach it at http://nudge.$name.wired",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                if (isHome && !homeOnWired) {
                                    OutlinedButton(onClick = { usingAddress = name }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                                        Text("Use as your home's address")
                                    }
                                }
                            }
                            OutlinedButton(onClick = { turningOff = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                                Text("Turn off Wired", color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
                problem?.let {
                    Text(it, color = if (unsupported == null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    "Your servers reach each other over Wired, encrypted, with no port open at home: home holds the network, " +
                        "and servers with a public address join it.",
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
