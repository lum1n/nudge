package app.nudge.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MediumFlexibleTopAppBar
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.AppModel
import app.nudge.explain
import kotlinx.coroutines.launch
import nudge.ffi.AssistantFor
import nudge.ffi.AssistantSettings
import nudge.ffi.KeySource
import nudge.ffi.MadeAssistant
import nudge.ffi.ModelChoice
import nudge.ffi.NewAssistant
import nudge.ffi.ProviderKey
import nudge.ffi.ServerAssistant
import nudge.ffi.ServerInfo

/** The model a provider's new assistant starts with, until the owner picks another. */
private val DEFAULT_MODELS = mapOf("anthropic" to "claude-sonnet-5", "openai" to "gpt-6.1-sol")

/** How a provider is written, for the ones people know by name. */
private fun providerName(id: String) = mapOf("anthropic" to "Anthropic", "openai" to "OpenAI")[id]
    ?: id.replaceFirstChar { it.uppercase() }

/** The servers this device owns (ADR 11), and making another on exe.dev. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ServersScreen(model: AppModel, address: String?, exe: () -> Unit, close: () -> Unit) {
    val owned by model.servers.owned.collectAsStateWithLifecycle()
    var open by remember { mutableStateOf<String?>(null) }
    open?.let { server ->
        BackHandler { open = null }
        ServerScreen(model, server, address, close = { open = null })
        return
    }
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    Scaffold(
        containerColor = groupedBackground(),
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            MediumFlexibleTopAppBar(
                colors = groupedTopBarColors(),
                title = { Text("Servers") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                scrollBehavior = scrollBehavior,
            )
        },
    ) { padding ->
        LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = padding.calculateTopPadding(), bottom = 24.dp)) {
            group(
                "Yours",
                owned.map { server ->
                    { shapes ->
                        SegmentedListItem(
                            onClick = { open = server },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Dns, null) },
                            trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                        ) { Text(java.net.URI(server).host ?: server) }
                    }
                },
            )
            group(
                "New",
                listOf { shapes ->
                    SegmentedListItem(
                        onClick = exe,
                        shapes = shapes,
                        leadingContent = { Icon(Icons.Outlined.Cloud, null) },
                        supportingContent = { Text("A small server in your exe.dev account, with an HTTPS address") },
                    ) { Text("Make a server on exe.dev") }
                },
            )
        }
    }
}

/** One server: its updates, its assistants, the model keys set on it, and its recovery kit. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ServerScreen(model: AppModel, server: String, address: String?, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val client = remember(server) { model.servers.client(server) }
    var info by remember { mutableStateOf<ServerInfo?>(null) }
    var keys by remember { mutableStateOf<List<ProviderKey>>(emptyList()) }
    var problem by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<ServerAssistant?>(null) }
    var creating by remember { mutableStateOf(false) }
    var settingKey by remember { mutableStateOf<String?>(null) }
    var kit by remember { mutableStateOf(false) }

    suspend fun reload() {
        info = client.info()
        keys = client.keys(null)
    }

    fun act(action: suspend () -> Unit) = scope.launch {
        try {
            action()
            reload()
            problem = null
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    LaunchedEffect(server) { act {} }

    editing?.let { assistant ->
        BackHandler { editing = null }
        AssistantScreen(
            assistant,
            save = { settings -> client.updateAssistant(assistant.name, settings); reload() },
            delete = { client.deleteAssistant(assistant.name); reload() },
            close = { editing = null },
        )
        return
    }
    if (creating) {
        BackHandler { creating = false }
        NewAssistantScreen(
            keys, address,
            create = { new -> model.createAssistant(server, new).also { reload() } },
            close = { creating = false },
        )
        return
    }

    settingKey?.let { provider ->
        var key by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        var keyProblem by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { if (!busy) settingKey = null },
            title = { Text("${providerName(provider)} key") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = key,
                        onValueChange = { key = it },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        supportingText = { Text("For every assistant here. Tried once before it is kept.") },
                    )
                    keyProblem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = {
                TextButton(enabled = key.isNotBlank() && !busy, onClick = {
                    busy = true
                    scope.launch {
                        try {
                            client.setKey(provider, key.trim(), null)
                            reload()
                            settingKey = null
                        } catch (error: Exception) {
                            keyProblem = explain(error)
                        } finally {
                            busy = false
                        }
                    }
                }) { Text(if (busy) "Trying…" else "Save") }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { settingKey = null }) { Text("Cancel") } },
        )
    }

    if (kit) {
        var passphrase by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { kit = false },
            title = { Text("Recovery kit") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("With it and a backup, everything on this server can be brought back. Keep it away from the server, and the passphrase in your password manager.")
                    OutlinedTextField(
                        value = passphrase,
                        onValueChange = { passphrase = it },
                        label = { Text("Passphrase, 8 characters or more") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                    )
                }
            },
            confirmButton = {
                TextButton(enabled = passphrase.length >= 8, onClick = {
                    act {
                        val text = client.recoveryKit(passphrase)
                        kit = false
                        context.startActivity(
                            Intent.createChooser(
                                Intent(Intent.ACTION_SEND).setType("application/json")
                                    .putExtra(Intent.EXTRA_SUBJECT, "Nudge recovery kit for ${java.net.URI(server).host}")
                                    .putExtra(Intent.EXTRA_TEXT, text),
                                "Keep the recovery kit",
                            ),
                        )
                    }
                }) { Text("Make it") }
            },
            dismissButton = { TextButton(onClick = { kit = false }) { Text("Cancel") } },
        )
    }

    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    Scaffold(
        containerColor = groupedBackground(),
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            MediumFlexibleTopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(java.net.URI(server).host ?: server) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                scrollBehavior = scrollBehavior,
            )
        },
    ) { padding ->
        LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = padding.calculateTopPadding(), bottom = 24.dp)) {
            problem?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }
            val current = info ?: return@LazyColumn
            group(
                "Assistants",
                current.assistants.map<ServerAssistant, GroupRow> { assistant ->
                    { shapes ->
                        SegmentedListItem(
                            onClick = { editing = assistant },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.SmartToy, null) },
                            supportingContent = {
                                Text(if (assistant.running) assistant.settings.model.modelId else "Not running: check the server's log")
                            },
                            trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                        ) { Text(assistant.settings.displayName) }
                    }
                } + listOf<GroupRow> { shapes ->
                    SegmentedListItem(
                        onClick = { creating = true },
                        shapes = shapes,
                        leadingContent = { Icon(Icons.Outlined.Add, null) },
                    ) { Text("New assistant") }
                },
            )
            group(
                "Model keys",
                keys.map<ProviderKey, GroupRow> { key ->
                    { shapes ->
                        SegmentedListItem(
                            onClick = { if (key.source != KeySource.ENV) settingKey = key.provider },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Key, null) },
                            supportingContent = {
                                Text(
                                    when (key.source) {
                                        KeySource.ENV -> "From the server's environment (${key.variables.joinToString()})"
                                        KeySource.SERVER -> "Set here, for every assistant. Tap to change it."
                                        KeySource.ASSISTANT -> "Set for one assistant"
                                        KeySource.NONE -> "None yet. Tap to add your key."
                                    },
                                )
                            },
                        ) { Text(providerName(key.provider)) }
                    }
                },
            )
            group(
                "Server",
                buildList<GroupRow> {
                    current.updates?.let { updates ->
                        add { shapes ->
                            SegmentedListItem(
                                checked = updates.automatic,
                                onCheckedChange = { on -> act { client.setUpdates(on) } },
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.SystemUpdate, null) },
                                overlineContent = { Text("Version ${updates.current}") },
                                supportingContent = {
                                    Text(updates.error ?: updates.available?.let { "$it is out" } ?: "Installs new releases itself")
                                },
                                trailingContent = { Switch(checked = updates.automatic, onCheckedChange = null) },
                            ) { Text("Update automatically") }
                        }
                    }
                    add { shapes ->
                        SegmentedListItem(
                            onClick = { kit = true },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Lock, null) },
                            supportingContent = { Text("The backup key, sealed with a passphrase") },
                        ) { Text("Recovery kit") }
                    }
                    add { shapes ->
                        SegmentedListItem(
                            onClick = { scope.launch { model.servers.forget(server); close() } },
                            shapes = shapes,
                            supportingContent = { Text("This device stops managing it. Nothing on the server changes.") },
                        ) { Text("Sign out as owner") }
                    }
                },
            )
        }
    }
}

/** A new assistant: its name, its model, and who it is for. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NewAssistantScreen(
    keys: List<ProviderKey>,
    address: String?,
    create: suspend (NewAssistant) -> MadeAssistant,
    close: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val ready = keys.filter { it.source != KeySource.NONE }.map { it.provider }
    var name by remember { mutableStateOf("") }
    var provider by remember { mutableStateOf(ready.firstOrNull() ?: "anthropic") }
    var modelId by remember { mutableStateOf(DEFAULT_MODELS[provider].orEmpty()) }
    var forMe by remember { mutableStateOf(address != null) }
    var person by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var made by remember { mutableStateOf<MadeAssistant?>(null) }

    Scaffold(
        topBar = {
            androidx.compose.material3.TopAppBar(
                title = { Text("New assistant") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                val done = made
                if (done != null) {
                    val pairing = done.pairing
                    if (pairing != null) {
                        Text("${done.assistant.settings.displayName} is ready for $person", style = MaterialTheme.typography.headlineSmall)
                        Text("Send them this link, or have them type the code ${pairing.code} in the Nudge app. It works once, for ten minutes.")
                        Button(onClick = {
                            context.startActivity(
                                Intent.createChooser(
                                    Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, pairing.link),
                                    "Send the link",
                                ),
                            )
                        }) { Text("Send the link") }
                    } else {
                        Text("${done.assistant.settings.displayName} is ready", style = MaterialTheme.typography.headlineSmall)
                        Text("You joined it from home: its rooms are beside your own.")
                    }
                    TextButton(onClick = close) { Text("Done") }
                    return@Column
                }
                OutlinedTextField(
                    value = name, onValueChange = { name = it }, label = { Text("Its name") },
                    supportingText = { Text("In its address: ${slugOf(name).ifEmpty { "…" }}") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                Text("Model", style = MaterialTheme.typography.labelLarge)
                listOf("anthropic", "openai").forEach { option ->
                    Row(
                        Modifier.fillMaxWidth().selectable(selected = provider == option, onClick = {
                            provider = option
                            modelId = DEFAULT_MODELS[option].orEmpty()
                        }),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = provider == option, onClick = null)
                        Text(
                            providerName(option) + if (option in ready) "" else " (add a key on the server first)",
                            Modifier.padding(start = 12.dp),
                        )
                    }
                }
                OutlinedTextField(value = modelId, onValueChange = { modelId = it }, label = { Text("Model id") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("Who is it for?", style = MaterialTheme.typography.labelLarge)
                if (address != null) {
                    Row(Modifier.fillMaxWidth().selectable(selected = forMe, onClick = { forMe = true }), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = forMe, onClick = null)
                        Text("Me: I join it from my home, and keep one sign-in", Modifier.padding(start = 12.dp))
                    }
                }
                Row(Modifier.fillMaxWidth().selectable(selected = !forMe, onClick = { forMe = false }), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = !forMe, onClick = null)
                    Text("Someone else: it is their home, and they are its admin", Modifier.padding(start = 12.dp))
                }
                if (!forMe) {
                    OutlinedTextField(value = person, onValueChange = { person = it }, label = { Text("Their name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button(
                    enabled = !busy && slugOf(name).isNotEmpty() && modelId.isNotBlank() && (forMe || person.isNotBlank()),
                    onClick = {
                        busy = true
                        scope.launch {
                            try {
                                made = create(
                                    NewAssistant(
                                        name = slugOf(name),
                                        settings = AssistantSettings(name.trim(), ModelChoice(provider, modelId.trim()), null, null, null),
                                        madeFor = if (forMe) AssistantFor.Me(address!!) else AssistantFor.SomeonesHome(person.trim()),
                                    ),
                                )
                            } catch (error: Exception) {
                                problem = explain(error)
                            } finally {
                                busy = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (busy) "Making it…" else "Make it") }
            }
        }
    }
}

/** An assistant's settings, and deleting it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AssistantScreen(
    assistant: ServerAssistant,
    save: suspend (AssistantSettings) -> Unit,
    delete: suspend () -> Unit,
    close: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var displayName by remember { mutableStateOf(assistant.settings.displayName) }
    var modelId by remember { mutableStateOf(assistant.settings.model.modelId) }
    var instructions by remember { mutableStateOf(assistant.settings.instructions.orEmpty()) }
    var confirm by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    fun act(action: suspend () -> Unit) = scope.launch {
        try {
            action()
            close()
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    if (deleting) {
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text("Delete ${assistant.settings.displayName}?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Its rooms, history and memory go. The server keeps a backup for 30 days. Type ${assistant.name} to delete it.")
                    OutlinedTextField(value = confirm, onValueChange = { confirm = it }, singleLine = true)
                }
            },
            confirmButton = {
                TextButton(enabled = confirm.trim() == assistant.name, onClick = { deleting = false; act(delete) }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } },
        )
    }

    Scaffold(
        topBar = {
            androidx.compose.material3.TopAppBar(
                title = { Text(assistant.settings.displayName) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            OutlinedTextField(value = displayName, onValueChange = { displayName = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(
                value = modelId, onValueChange = { modelId = it },
                label = { Text("Model (${assistant.settings.model.provider})") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = instructions, onValueChange = { instructions = it },
                label = { Text("Instructions") },
                supportingText = { Text("Said to the model before every conversation") },
                minLines = 3, modifier = Modifier.fillMaxWidth(),
            )
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                enabled = displayName.isNotBlank() && modelId.isNotBlank(),
                onClick = {
                    act {
                        save(
                            assistant.settings.copy(
                                displayName = displayName.trim(),
                                model = assistant.settings.model.copy(modelId = modelId.trim()),
                                instructions = instructions.trim().ifEmpty { null },
                            ),
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Save") }
            TextButton(onClick = { deleting = true }) { Text("Delete this assistant", color = MaterialTheme.colorScheme.error) }
        }
    }
}
