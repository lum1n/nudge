package app.nudge.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.AppModel
import app.nudge.ServerProblem
import app.nudge.explain
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import nudge.ffi.NudgeException
import nudge.ffi.TailscaleState
import nudge.ffi.TailscaleStatus

/**
 * A server's own Tailscale (ADR 11), so it reaches a home that is only in the person's tailnet:
 * connecting opens Tailscale's page to approve it, and the card follows until it is in. A server
 * too old for it says so, with a check for the release that has it. `changed` hears each state
 * read, as the joining screens wait for it to be connected.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun TailscaleCard(model: AppModel, server: String, changed: (TailscaleState) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val client = remember(server) { model.servers.client(server) }
    var state by remember(server) { mutableStateOf<TailscaleState?>(null) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var disconnecting by remember { mutableStateOf(false) }
    // Why the server can't run Tailscale, when it answered that it can't.
    var unsupported by remember(server) { mutableStateOf<String?>(null) }
    // Tapped Connect: Tailscale's page opens once the server has its login link.
    var opening by remember { mutableStateOf(false) }
    val waiting = state?.state.let {
        it == TailscaleStatus.STARTING || it == TailscaleStatus.NEEDS_LOGIN || it == TailscaleStatus.NEEDS_APPROVAL
    }

    fun open(url: String) = context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))

    fun show(next: TailscaleState) {
        unsupported = null
        state = next
        if (opening && next.state != TailscaleStatus.STARTING) {
            opening = false
            if (next.state == TailscaleStatus.NEEDS_LOGIN) next.authUrl?.let { open(it) }
        }
        problem = null
        changed(next)
    }

    fun act(action: suspend () -> TailscaleState) = scope.launch {
        busy = true
        try {
            show(action())
        } catch (error: Exception) {
            problem = explain(error)
        } finally {
            busy = false
        }
    }

    LaunchedEffect(server, waiting) {
        suspend fun read() {
            try {
                show(client.tailscale())
            } catch (error: NudgeException.Status) {
                if (error.status.toInt() == 404) {
                    state = null
                    unsupported = if ("Linux" in error.detail) {
                        error.detail
                    } else {
                        "This server's Nudge is older than Tailscale support. It installs new releases itself; check for one now."
                    }
                } else {
                    problem = explain(error)
                }
            } catch (error: Exception) {
                problem = explain(error)
            }
        }
        read()
        // Until someone approved it, or it gave up.
        while (waiting) {
            delay(2_000)
            read()
        }
    }

    if (disconnecting) {
        AlertDialog(
            onDismissRequest = { disconnecting = false },
            title = { Text("Disconnect from your tailnet?") },
            text = { Text("The server stops reaching assistants that are only in your tailnet.") },
            confirmButton = {
                TextButton(onClick = {
                    disconnecting = false
                    act { client.disconnectTailscale() }
                }) { Text("Disconnect", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { disconnecting = false }) { Text("Cancel") } },
        )
    }

    unsupported?.let { why ->
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Section("Tailscale")
            Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.large) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
                                } catch (error: Exception) {
                                    problem = explain(error)
                                } finally {
                                    busy = false
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (busy) "Checking…" else "Check for updates") }
                    problem?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        }
        return
    }
    val current = state
    fun connect() {
        opening = true
        act { client.connectTailscale(null) }
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Section("Tailscale")
        Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.large) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                when (current?.state) {
                    // Not read yet, or reading it failed: the problem below says why.
                    null -> if (problem == null) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            LoadingIndicator()
                            Text("Checking Tailscale…", Modifier.padding(start = 12.dp))
                        }
                    }
                    TailscaleStatus.OFF ->
                        Button(onClick = { connect() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                            Text("Connect to your tailnet")
                        }
                    TailscaleStatus.ERROR -> {
                        Text(current.error ?: "Tailscale stopped.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = { connect() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Try again") }
                    }
                    TailscaleStatus.STARTING -> Row(verticalAlignment = Alignment.CenterVertically) {
                        LoadingIndicator()
                        Text("Starting Tailscale…", Modifier.padding(start = 12.dp))
                    }
                    TailscaleStatus.NEEDS_LOGIN -> {
                        current.authUrl?.let { url ->
                            Button(onClick = { open(url) }, modifier = Modifier.fillMaxWidth()) { Text("Approve it in Tailscale") }
                        }
                        Text(
                            "Sign in to Tailscale and add this server to your tailnet. This page follows along.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TailscaleStatus.NEEDS_APPROVAL ->
                        Text("Waiting for your tailnet's admin to approve the server.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TailscaleStatus.CONNECTED -> {
                        Text(
                            "In your tailnet as ${current.name ?: current.addresses.firstOrNull() ?: "this server"}",
                            color = MaterialTheme.colorScheme.primary,
                        )
                        OutlinedButton(onClick = { disconnecting = true }, modifier = Modifier.fillMaxWidth()) {
                            Text("Disconnect", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Text(
                    "In your tailnet, this server reaches assistants that are only there, such as a home at a Tailscale address.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** Why the home can't join assistants on other servers yet, followed as the home answers. */
@Composable
fun homeProblem(model: AppModel): ServerProblem.Kind? {
    val session by model.session.collectAsStateWithLifecycle()
    val memberships by model.memberships.collectAsStateWithLifecycle()
    val federation by model.homeFederation.collectAsStateWithLifecycle()
    return remember(session, memberships, federation) { model.homeProblem() }
}

/**
 * What the person's home lacks to join assistants on other servers, and turning federation on
 * there. Shows nothing when it lacks nothing, or while signed out.
 */
@Composable
fun HomeFederationCard(model: AppModel) {
    val scope = rememberCoroutineScope()
    val missing = homeProblem(model) ?: return
    val session by model.session.collectAsStateWithLifecycle()
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.large) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Your home first", style = MaterialTheme.typography.titleMedium)
            Text(missing.text)
            if (missing == ServerProblem.Kind.NO_FEDERATION) {
                Button(
                    enabled = !busy,
                    onClick = {
                        busy = true
                        scope.launch {
                            try {
                                model.turnOnFederation()
                                problem = null
                            } catch (error: Exception) {
                                problem = explain(error)
                            } finally {
                                busy = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (busy) "Turning it on…" else "Turn on federation at home") }
                session?.let {
                    Text(
                        "Other servers will reach your home at ${it.account.server}.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}
