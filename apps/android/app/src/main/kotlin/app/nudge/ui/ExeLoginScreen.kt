package app.nudge.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.nudge.AppModel
import app.nudge.explain
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import nudge.ffi.ExeClient
import nudge.ffi.ExeLogin
import nudge.ffi.ExeLoginListener
import nudge.ffi.exeMintToken

/** The terminal's size: wide enough for exe.dev's banner, small enough to read on a phone. */
private const val COLUMNS: UShort = 54u
private const val ROWS: UShort = 16u

/**
 * Signing in to exe.dev on the device (ADR 11): `ssh exe.dev` with the app's own key, its screen
 * shown and what the person types sent. exe.dev asks for their email and mails a link that adds the
 * key to their account, new or not; meanwhile the app tries a token signed with that key until
 * exe.dev takes it, and gives it to `signedIn`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExeLoginScreen(model: AppModel, close: () -> Unit, signedIn: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var screen by remember { mutableStateOf("") }
    var ended by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var typed by remember { mutableStateOf("") }
    var session by remember { mutableStateOf<ExeLogin?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    fun failed(text: String?) {
        ended = "exe.dev ended the session."
        if (text != null) problem = text
    }
    // The library calls back on its own threads.
    val listener = remember {
        object : ExeLoginListener {
            override fun onScreen(text: String) {
                scope.launch { screen = text }
            }

            override fun onClosed(problem: String?) {
                scope.launch { failed(problem) }
            }
        }
    }

    DisposableEffect(attempt) {
        ended = null
        problem = null
        screen = ""
        val job = scope.launch {
            try {
                session = ExeLogin.start(model.servers.exeKey(), COLUMNS, ROWS, listener)
            } catch (error: Exception) {
                ended = "Couldn't connect to exe.dev."
                problem = explain(error)
            }
        }
        onDispose {
            job.cancel()
            session?.end()
            session = null
        }
    }

    // The key's link may be opened with the app in the background, so this doesn't wait for the
    // session: it tries the token every few seconds until exe.dev takes it.
    LaunchedEffect(Unit) {
        val token = try {
            exeMintToken(model.servers.exeKey(), 365u)
        } catch (error: Exception) {
            problem = explain(error)
            return@LaunchedEffect
        }
        val exe = ExeClient(token)
        while (isActive) {
            if (runCatching { exe.whoami() }.isSuccess) {
                model.servers.exeToken = token
                session?.end()
                signedIn(token)
                return@LaunchedEffect
            }
            delay(3_000)
        }
    }

    fun send() {
        val text = typed.trim()
        if (text.isEmpty()) return
        session?.send(text + "\r")
        typed = ""
    }

    BackHandler { close() }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Sign in to exe.dev") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                    BoxWithConstraints(Modifier.fillMaxWidth().padding(8.dp)) {
                        val size = with(LocalDensity.current) { (maxWidth / (COLUMNS.toInt() * 0.61f)).toSp() }
                        Text(
                            screen.ifEmpty { "Connecting to exe.dev…" },
                            fontFamily = FontFamily.Monospace,
                            fontSize = size,
                            lineHeight = size * 1.2f,
                            minLines = ROWS.toInt(),
                            softWrap = false,
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = typed,
                        onValueChange = { typed = it },
                        label = { Text("Your email, or what exe.dev asks") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Send, autoCorrectEnabled = false),
                        keyboardActions = KeyboardActions(onSend = { send() }),
                        shape = MaterialTheme.shapes.large,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = ::send, enabled = ended == null) { Icon(Icons.AutoMirrored.Filled.Send, "Send") }
                }
                Text(
                    "exe.dev asks for your email and sends you a link. Open it, then come back: the app is signed in once exe.dev has your key.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                ended?.let { reason ->
                    Text(reason, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = { attempt++ }, modifier = Modifier.heightIn(min = 40.dp)) { Text("Start again") }
                }
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}
