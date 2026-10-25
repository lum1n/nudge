package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.toShape
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.AppModel
import app.nudge.R
import app.nudge.explain
import app.nudge.text
import kotlinx.coroutines.launch
import nudge.ffi.Assistant
import nudge.ffi.listAssistants

/**
 * Pairing: the server's address, which assistant, and the one-time code an admin made, under
 * People and devices or with `nudge pair <player>`. A `nudge://pair` link fills all three.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun SignInScreen(model: AppModel, askForNotifications: () -> Unit, setUp: () -> Unit, exe: () -> Unit) {
    val scope = rememberCoroutineScope()
    val link by model.pendingLink.collectAsStateWithLifecycle()
    val signedOutBecause by model.signedOutBecause.collectAsStateWithLifecycle()
    var server by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var assistants by remember { mutableStateOf<List<Assistant>>(emptyList()) }
    var assistant by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    suspend fun findAssistants(): List<Assistant> {
        val address = normalizedAddress(server)
        if (address.isEmpty()) return emptyList()
        busy = true
        try {
            val found = listAssistants(address)
            assistants = found
            if (found.none { it.name == assistant }) assistant = found.firstOrNull()?.name
            problem = if (found.isEmpty()) text(R.string.setup_no_assistants) else null
            return found
        } catch (error: Exception) {
            problem = explain(error)
            return emptyList()
        } finally {
            busy = false
        }
    }

    fun signIn() = scope.launch {
        val found = assistants.ifEmpty { findAssistants() }
        val chosen = found.firstOrNull { it.name == assistant } ?: return@launch
        busy = true
        try {
            model.signIn(normalizedAddress(server), chosen, code.trim())
            askForNotifications()
        } catch (error: Exception) {
            problem = explain(error)
        } finally {
            busy = false
        }
    }

    LaunchedEffect(link) {
        val pairing = link ?: return@LaunchedEffect
        server = pairing.server
        code = pairing.code
        assistants = emptyList()
        val found = findAssistants()
        if (found.any { it.name == pairing.assistant }) assistant = pairing.assistant
        model.pendingLink.value = null
    }

    Scaffold { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Surface(
                    shape = MaterialShapes.Cookie9Sided.toShape(),
                    color = MaterialTheme.colorScheme.primaryContainer,
                    modifier = Modifier.size(96.dp),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            Icons.Outlined.Forum, null,
                            Modifier.size(44.dp),
                            tint = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                }
                Text("Nudge", style = MaterialTheme.typography.displayMediumEmphasized)
                Text(
                    stringResource(R.string.setup_pair_intro),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                signedOutBecause?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                OutlinedTextField(
                    value = server,
                    onValueChange = {
                        server = it
                        assistants = emptyList()
                    },
                    label = { Text(stringResource(R.string.setup_server)) },
                    placeholder = { Text("https://nudge.example") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { scope.launch { findAssistants() } }),
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (assistants.size > 1) {
                    Text(stringResource(R.string.setup_assistant), style = MaterialTheme.typography.labelLarge)
                    assistants.forEach { option ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .selectable(selected = option.name == assistant, onClick = { assistant = option.name }),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = option.name == assistant, onClick = { assistant = option.name })
                            Text(option.displayName)
                        }
                    }
                }
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it },
                    label = { Text(stringResource(R.string.setup_pairing_code)) },
                    placeholder = { Text("XXXX-XXXX") },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Characters,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { signIn() }),
                    supportingText = {
                        Text(stringResource(R.string.setup_pairing_hint))
                    },
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth(),
                )
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) {
                    LoadingIndicator(Modifier.align(Alignment.CenterHorizontally))
                } else {
                    Button(
                        onClick = { signIn() },
                        enabled = server.isNotBlank() && code.isNotBlank(),
                        shapes = ButtonDefaults.shapes(),
                        contentPadding = ButtonDefaults.contentPaddingFor(ButtonDefaults.MediumContainerHeight),
                        modifier = Modifier.fillMaxWidth().heightIn(min = ButtonDefaults.MediumContainerHeight),
                    ) {
                        Text(stringResource(R.string.setup_sign_in), style = ButtonDefaults.textStyleFor(ButtonDefaults.MediumContainerHeight))
                    }
                }
                Text(
                    stringResource(R.string.setup_no_server),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(top = 16.dp),
                )
                OutlinedButton(onClick = exe, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_make_on_exe)) }
                OutlinedButton(onClick = setUp, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_set_up_started)) }
            }
        }
    }
}

/**
 * `nudge.example` → `https://nudge.example`, `192.168.1.10:8787` → `http://192.168.1.10:8787` (a
 * server on the local network rarely has a certificate), and no trailing slash.
 */
internal fun normalizedAddress(text: String): String {
    var address = text.trim()
    if (address.isEmpty()) return address
    if ("://" !in address) address = (if (isLocal(address)) "http://" else "https://") + address
    return address.trimEnd('/')
}

/** Whether an address without a scheme names a host on this network. */
private fun isLocal(address: String): Boolean {
    var host = address.substringBefore('/').lowercase()
    if (host.startsWith("[")) return listOf("[fd", "[fc", "[fe80", "[::1]").any { host.startsWith(it) }
    host = host.substringBeforeLast(':')
    if (host == "localhost" || listOf(".local", ".lan", ".home.arpa", ".internal").any { host.endsWith(it) }) {
        return true
    }
    val parts = host.split('.').mapNotNull { it.toIntOrNull() }
    if (parts.size != 4) return false
    val (a, b) = parts
    return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 169 && b == 254) ||
        (a == 172 && b in 16..31) || (a == 100 && b in 64..127) // carrier-grade NAT, such as Tailscale
}
