package app.nudge.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.nudge.AppModel
import app.nudge.explain
import kotlinx.coroutines.launch
import nudge.ffi.ExeClient
import nudge.ffi.exeTokenCommand

/**
 * A new server on exe.dev (ADR 11): the person runs one command to mint a token for the app, which
 * keeps it on this device, names the server, and the app makes it and waits until it can be set
 * up. Then `ready` gets its address and setup code, for the setup wizard.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ExeScreen(model: AppModel, close: () -> Unit, ready: (SetupStart) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var token by remember { mutableStateOf(model.servers.exeToken.orEmpty()) }
    var name by remember { mutableStateOf("nudge") }
    var busy by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    val command = remember { exeTokenCommand() }

    fun launch() = scope.launch {
        busy = true
        problem = null
        try {
            val exe = ExeClient(token.trim())
            progress = "Checking the token…"
            exe.whoami()
            model.servers.exeToken = token.trim()
            progress = "Making the server, then waiting for it to start. This takes a minute or two."
            val launched = exe.launchServer(slugOf(name).ifEmpty { "nudge" }, 300u)
            ready(SetupStart(launched.vm.url, launched.code))
        } catch (error: Exception) {
            problem = explain(error)
        } finally {
            busy = false
            progress = null
        }
    }

    BackHandler(enabled = !busy) { close() }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("A server on exe.dev") },
                navigationIcon = { IconButton(onClick = close, enabled = !busy) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(
                    "Nudge makes a small server in your exe.dev account, billed to it, with an HTTPS address of its own.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text("1. Give the app a token", style = MaterialTheme.typography.titleMedium)
                Text("Run this once on a computer with your exe.dev key, and paste what it prints:")
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                    Text(command, Modifier.padding(12.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
                TextButton(onClick = { copy(context, command) }) { Text("Copy the command") }
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("exe.dev token") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    supportingText = { Text("It stays on this device. It can make and remove servers, nothing else.") },
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("2. Name the server", style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Server name") },
                    singleLine = true,
                    supportingText = { Text("Its address will be https://${slugOf(name).ifEmpty { "nudge" }}.exe.xyz") },
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth(),
                )
                progress?.let { Text(it) }
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) {
                    LoadingIndicator(Modifier.align(Alignment.CenterHorizontally))
                } else {
                    Button(
                        onClick = { launch() },
                        enabled = token.isNotBlank() && slugOf(name).isNotEmpty(),
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.fillMaxWidth().heightIn(min = ButtonDefaults.MediumContainerHeight),
                    ) { Text("Make the server") }
                }
            }
        }
    }
}

private fun copy(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("exe.dev command", text))
}
