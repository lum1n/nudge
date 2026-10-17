package app.nudge.ui

import android.content.Intent
import android.net.Uri
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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.nudge.AppModel
import app.nudge.SetUpServer
import app.nudge.explain
import java.text.Normalizer
import kotlinx.coroutines.launch
import nudge.ffi.ModelChoice
import nudge.ffi.NudgeException
import nudge.ffi.SetupChoices
import nudge.ffi.SetupInfo
import nudge.ffi.TailscaleStatus
import nudge.ffi.checkSetupCode
import nudge.ffi.checkSetupKey
import nudge.ffi.setupInfo

/** Where setup starts: a server's address, and its code when the app knows it, as after exe.dev. */
data class SetupStart(val server: String = "", val code: String = "")

private enum class Step { ADDRESS, CODE, NAME, MODEL, YOU, TAILSCALE }

/** Where people get a key for each provider setup offers. */
private val KEY_PAGES = mapOf(
    "anthropic" to "https://console.anthropic.com/settings/keys",
    "openai" to "https://platform.openai.com/api-keys",
)

/**
 * The setup wizard (ADR 11), as the web's: a server waiting to be set up, its one-time code, a
 * name for the assistant, a model with the person's own key (or a model server found there), and
 * their name. Setting up signs this device in to the server as its owner, and to the new assistant:
 * as the person's home, or joined from it when they are signed in at home already. Then the home
 * needs federation, checked before anything is made, and a home only in a tailnet needs the server
 * in that tailnet too, which the last step connects.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun SetupScreen(model: AppModel, start: SetupStart, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var step by remember { mutableStateOf(if (start.server.isEmpty()) Step.ADDRESS else if (start.code.isEmpty()) Step.CODE else Step.NAME) }
    var server by remember { mutableStateOf(start.server) }
    var code by remember { mutableStateOf(start.code) }
    var info by remember { mutableStateOf<SetupInfo?>(null) }
    var name by remember { mutableStateOf("") }
    var slug by remember { mutableStateOf<String?>(null) }
    var provider by remember { mutableStateOf<String?>(null) }
    var modelId by remember { mutableStateOf<String?>(null) }
    var key by remember { mutableStateOf("") }
    var you by remember { mutableStateOf("") }
    var backups by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    // The assistant setup made, for joining it from home once the server is in the tailnet.
    var made by remember { mutableStateOf<String?>(null) }
    val missing = homeProblem(model)
    val assistant = slug ?: slugOf(name)
    val offered = info?.providers?.firstOrNull { it.id == provider }
    val local = info?.local?.firstOrNull { it.id == provider }

    fun back() {
        problem = null
        step = when (step) {
            Step.ADDRESS -> return close()
            Step.CODE -> if (start.server.isEmpty()) Step.ADDRESS else return close()
            Step.NAME -> if (start.code.isEmpty()) Step.CODE else return close()
            Step.MODEL -> Step.NAME
            Step.YOU -> Step.MODEL
            // Set up already: joining from home waits under Servers until then.
            Step.TAILSCALE -> return close()
        }
    }

    fun run(work: suspend () -> Unit) = scope.launch {
        busy = true
        problem = null
        try {
            work()
        } catch (error: NudgeException.Status) {
            problem = when (error.status.toInt()) {
                401 -> "That isn't the setup code."
                410 -> "Setup closed: the server is set up already, or took too many wrong codes. Restart it for a new code."
                else -> error.detail
            }
        } catch (error: Exception) {
            problem = explain(error)
        } finally {
            busy = false
        }
    }

    suspend fun load() {
        val found = setupInfo(server)
        if (!found.open) throw IllegalStateException("That server is set up already: sign in to it instead.")
        info = found
        if (provider == null) {
            val first = found.providers.firstOrNull()
            provider = first?.id
            modelId = first?.recommended
        }
    }

    // A server from exe.dev comes with its address and code: ask it what it offers first.
    LaunchedEffect(Unit) { if (start.server.isNotEmpty()) run { load() } }

    BackHandler { back() }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Set up Nudge") },
                navigationIcon = { IconButton(onClick = ::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                if (step != Step.TAILSCALE) HomeFederationCard(model)
                when (step) {
                    Step.ADDRESS -> {
                        Text("Where is the server?", style = MaterialTheme.typography.headlineSmall)
                        Text(
                            "A server that isn't set up yet prints its address and a setup code when it starts.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Field(server, { server = it }, "Server", "https://nudge.example", KeyboardType.Uri)
                    }
                    Step.CODE -> {
                        Text("Its setup code", style = MaterialTheme.typography.headlineSmall)
                        OutlinedTextField(
                            value = code,
                            onValueChange = { code = it },
                            label = { Text("Setup code") },
                            placeholder = { Text("XXXX-XXXX-XXXX") },
                            singleLine = true,
                            textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                            supportingText = { Text("The server printed it when it started.") },
                            shape = MaterialTheme.shapes.large,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Step.NAME -> {
                        Text("Name your assistant", style = MaterialTheme.typography.headlineSmall)
                        Field(name, { name = it }, "Its name", "Robin", supporting = "What it calls itself. You can change it later.")
                        Field(
                            assistant, { slug = slugOf(it) }, "In its address", null,
                            supporting = "Part of every address of the people here, so this one stays.",
                        )
                    }
                    Step.MODEL -> {
                        Text("Choose its model", style = MaterialTheme.typography.headlineSmall)
                        info?.providers?.forEach { option ->
                            Choice(option.id == provider, option.name, "With your own API key") {
                                provider = option.id
                                modelId = option.recommended
                            }
                        }
                        info?.local?.forEach { option ->
                            Choice(option.id == provider, option.name, "Running on the server; no key") {
                                provider = option.id
                                modelId = option.models.firstOrNull()
                            }
                        }
                        val models = offered?.models?.map { it.id to it.name } ?: local?.models?.map { it to it } ?: emptyList()
                        if (models.size > 1) {
                            Text("Model", style = MaterialTheme.typography.labelLarge)
                            models.forEach { (id, label) -> Choice(id == modelId, label, null) { modelId = id } }
                        }
                        if (offered != null) {
                            OutlinedTextField(
                                value = key,
                                onValueChange = { key = it },
                                label = { Text("${offered.name} API key") },
                                singleLine = true,
                                visualTransformation = PasswordVisualTransformation(),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                                supportingText = { Text("Kept encrypted on the server, never shown again.") },
                                shape = MaterialTheme.shapes.large,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            KEY_PAGES[offered.id]?.let { page ->
                                TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(page))) }) {
                                    Text("Get a key")
                                }
                            }
                        }
                    }
                    Step.YOU -> {
                        Text("And you?", style = MaterialTheme.typography.headlineSmall)
                        Field(
                            you, { you = it }, "Your name", null,
                            supporting = "You will be ${name.trim().ifEmpty { "the assistant" }}'s first person, its admin, and this server's owner.",
                        )
                        Row(
                            Modifier.fillMaxWidth().selectable(selected = backups, onClick = { backups = !backups }),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked = backups, onCheckedChange = null)
                            Text(
                                "Back up every night, keeping two weeks, beside the data",
                                Modifier.padding(start = 12.dp),
                            )
                        }
                    }
                    Step.TAILSCALE -> {
                        Text("One more step", style = MaterialTheme.typography.headlineSmall)
                        Text("Your home is only in your tailnet. Add this server to it, and your home joins ${name.trim()} from there.")
                        fun join() {
                            val joining = made ?: return
                            busy = true
                            run {
                                if (!model.isSignedIn(server, joining)) model.joinFromHome(server, joining)
                                close()
                            }
                        }
                        var connected by remember { mutableStateOf(false) }
                        TailscaleCard(model, server) { state ->
                            connected = state.state == TailscaleStatus.CONNECTED
                            if (connected && !busy && problem == null) join()
                        }
                        if (connected && problem != null && !busy) {
                            Button(onClick = { join() }, modifier = Modifier.fillMaxWidth()) { Text("Join it from home") }
                        }
                        TextButton(onClick = close) { Text("Later") }
                    }
                }
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) {
                    LoadingIndicator(Modifier.align(Alignment.CenterHorizontally))
                } else if (step != Step.TAILSCALE) {
                    val ready = missing == null && when (step) {
                        Step.ADDRESS -> server.isNotBlank()
                        Step.CODE -> code.isNotBlank()
                        Step.NAME -> name.isNotBlank() && assistant.isNotEmpty()
                        Step.MODEL -> provider != null && modelId != null && (local != null || key.isNotBlank())
                        Step.YOU -> you.isNotBlank()
                        Step.TAILSCALE -> false
                    }
                    Button(
                        onClick = {
                            when (step) {
                                Step.ADDRESS -> run {
                                    server = normalizedAddress(server)
                                    load()
                                    step = Step.CODE
                                }
                                Step.CODE -> run {
                                    checkSetupCode(server, code.trim())
                                    step = Step.NAME
                                }
                                Step.NAME -> step = Step.MODEL
                                Step.MODEL -> run {
                                    if (local == null) checkSetupKey(server, code.trim(), provider!!, key.trim())
                                    step = Step.YOU
                                }
                                Step.YOU -> run {
                                    val ended = model.setUp(
                                        server,
                                        SetupChoices(
                                            code = code.trim(),
                                            assistantName = assistant,
                                            displayName = name.trim(),
                                            model = ModelChoice(local?.id ?: provider!!, modelId!!),
                                            key = if (local == null) key.trim() else null,
                                            local = local?.id,
                                            yourName = you.trim(),
                                            publicUrl = server,
                                            backups = backups,
                                        ),
                                    )
                                    if (ended is SetUpServer.NeedsTailscale) {
                                        made = ended.assistant
                                        step = Step.TAILSCALE
                                    } else {
                                        close()
                                    }
                                }
                                Step.TAILSCALE -> {}
                            }
                        },
                        enabled = ready,
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.fillMaxWidth().heightIn(min = ButtonDefaults.MediumContainerHeight),
                    ) {
                        Text(if (step == Step.YOU) "Set up" else "Continue")
                    }
                }
            }
        }
    }
}

@Composable
private fun Field(
    value: String,
    change: (String) -> Unit,
    label: String,
    placeholder: String?,
    type: KeyboardType = KeyboardType.Text,
    supporting: String? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = change,
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it) } },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = type),
        supportingText = supporting?.let { { Text(it) } },
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun Choice(selected: Boolean, label: String, detail: String?, choose: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected = selected, onClick = choose),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Column(Modifier.padding(start = 12.dp)) {
            Text(label)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/** An assistant's name as its address has it: lower case, dashes for the rest. */
fun slugOf(name: String): String =
    Normalizer.normalize(name, Normalizer.Form.NFKD)
        .replace(Regex("\\p{M}"), "")
        .lowercase()
        .replace(Regex("[^a-z0-9]+"), "-")
        .trim('-')
        .take(40)
