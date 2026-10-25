package app.nudge.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.nudge.AppModel
import app.nudge.R
import app.nudge.explain
import app.nudge.text
import kotlinx.coroutines.launch
import nudge.ffi.ExeClient
import nudge.ffi.exeTokenCommand

/**
 * A new server on exe.dev (ADR 11): the person signs in to exe.dev here (or pastes a token they
 * minted on a computer), names the server, and the app makes it and waits until it can be set up.
 * Then `ready` gets its address and setup code, for the setup wizard.
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
    // Whether the token came from signing in here, or one kept from before.
    var signedIn by remember { mutableStateOf(model.servers.exeToken != null) }
    var signingIn by remember { mutableStateOf(false) }
    var pasting by remember { mutableStateOf(false) }
    val missing = homeProblem(model)
    // The owned server holding a Wired network, which the new server joins as it starts.
    var wiredHome by remember { mutableStateOf<String?>(null) }
    var joinWired by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) { wiredHome = model.servers.wiredRoot() }

    fun launch() = scope.launch {
        busy = true
        problem = null
        try {
            val exe = ExeClient(token.trim())
            progress = text(R.string.setup_exe_checking)
            exe.whoami()
            model.servers.exeToken = token.trim()
            progress = text(R.string.setup_exe_making)
            val vmName = slugOf(name).ifEmpty { "nudge" }
            val home = wiredHome
            val launched = if (joinWired && home != null) {
                exe.launchWiredServer(vmName, 300u, model.servers.client(home))
            } else {
                exe.launchServer(vmName, 300u)
            }
            ready(SetupStart(launched.vm.url, launched.code))
        } catch (error: Exception) {
            problem = explain(error)
        } finally {
            busy = false
            progress = null
        }
    }

    if (signingIn) {
        ExeLoginScreen(
            model,
            close = { signingIn = false },
            signedIn = { minted ->
                token = minted
                signedIn = true
                signingIn = false
            },
        )
        return
    }

    BackHandler(enabled = !busy) { close() }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.setup_exe_title)) },
                navigationIcon = { IconButton(onClick = close, enabled = !busy) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.setup_back)) } },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(
                    stringResource(R.string.setup_exe_intro),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                // Before anything is made: its first assistant is joined from home.
                HomeFederationCard(model)
                Text(stringResource(R.string.setup_exe_step_sign_in), style = MaterialTheme.typography.titleMedium)
                if (signedIn) {
                    Text(stringResource(R.string.setup_exe_signed_in), color = MaterialTheme.colorScheme.primary)
                }
                OutlinedButton(onClick = { signingIn = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(if (signedIn) R.string.setup_exe_sign_in_again else R.string.setup_exe_sign_in))
                }
                Text(
                    stringResource(R.string.setup_exe_new),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { pasting = !pasting }) { Text(stringResource(R.string.setup_exe_paste)) }
                if (pasting) {
                    Text(stringResource(R.string.setup_exe_run_this))
                    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                        Text(command, Modifier.padding(12.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                    }
                    TextButton(onClick = { copy(context, command) }) { Text(stringResource(R.string.setup_exe_copy)) }
                    OutlinedTextField(
                        value = token,
                        onValueChange = { token = it },
                        label = { Text(stringResource(R.string.setup_exe_token)) },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                        shape = MaterialTheme.shapes.large,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Text(stringResource(R.string.setup_exe_step_name), style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.setup_exe_server_name)) },
                    singleLine = true,
                    supportingText = { Text(stringResource(R.string.setup_exe_address, slugOf(name).ifEmpty { "nudge" })) },
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth(),
                )
                wiredHome?.let { home ->
                    Row(
                        Modifier.fillMaxWidth().toggleable(value = joinWired, enabled = !busy, onValueChange = { joinWired = it }),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.setup_exe_join_wired, java.net.URI(home).host ?: home))
                            Text(
                                stringResource(R.string.setup_exe_join_wired_hint),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(checked = joinWired, onCheckedChange = null, enabled = !busy)
                    }
                }
                progress?.let { Text(it) }
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) {
                    LoadingIndicator(Modifier.align(Alignment.CenterHorizontally))
                } else {
                    Button(
                        onClick = { launch() },
                        enabled = token.isNotBlank() && slugOf(name).isNotEmpty() && missing == null,
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.fillMaxWidth().heightIn(min = ButtonDefaults.MediumContainerHeight),
                    ) { Text(stringResource(R.string.setup_exe_make)) }
                }
            }
        }
    }
}

private fun copy(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("exe.dev command", text))
}
