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
import androidx.compose.material.icons.outlined.Backup
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Map
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
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.AppModel
import app.nudge.R
import app.nudge.exeVmName
import app.nudge.explain
import app.nudge.hostOf
import app.nudge.text
import kotlinx.coroutines.launch
import nudge.ffi.AssistantFor
import nudge.ffi.AssistantSettings
import nudge.ffi.BackupState
import nudge.ffi.GeoStatus
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
    val yours = stringResource(R.string.servers_yours)
    val newTitle = stringResource(R.string.servers_new)
    Scaffold(
        containerColor = groupedBackground(),
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            MediumFlexibleTopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(stringResource(R.string.servers_title)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.servers_back)) } },
                scrollBehavior = scrollBehavior,
            )
        },
    ) { padding ->
        LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = padding.calculateTopPadding(), bottom = 24.dp)) {
            group(
                yours,
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
                newTitle,
                listOf { shapes ->
                    SegmentedListItem(
                        onClick = exe,
                        shapes = shapes,
                        leadingContent = { Icon(Icons.Outlined.Cloud, null) },
                        supportingContent = { Text(stringResource(R.string.servers_exe_summary)) },
                    ) { Text(stringResource(R.string.servers_exe_make)) }
                },
            )
        }
    }
}

/**
 * One server: its updates, its assistants, the model keys set on it, its Wired, its backups and
 * its recovery kit; removing it, for one made on exe.dev.
 */
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
    var removing by remember { mutableStateOf(false) }
    var geo by remember { mutableStateOf<GeoStatus?>(null) }
    var maps by remember { mutableStateOf(false) }
    var backups by remember { mutableStateOf<BackupState?>(null) }
    var backingUp by remember { mutableStateOf(false) }
    // Followed, so assistants show as joined once they are.
    val places by model.places.collectAsStateWithLifecycle()
    val home by model.session.collectAsStateWithLifecycle()

    suspend fun reload() {
        info = client.info()
        keys = client.keys(null)
        // Older servers have no map.
        geo = runCatching { client.geo() }.getOrNull()
        // A server whose backups aren't run through its API (404) has none to show.
        backups = runCatching { client.backups() }.getOrNull()
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
    if (maps) {
        BackHandler { maps = false }
        MapsScreen(client, close = { maps = false; scope.launch { geo = runCatching { client.geo() }.getOrNull() } })
        return
    }
    if (backingUp) {
        BackHandler { backingUp = false }
        BackupsScreen(client, close = { backingUp = false; scope.launch { backups = runCatching { client.backups() }.getOrNull() } })
        return
    }
    editing?.let { assistant ->
        BackHandler { editing = null }
        AssistantScreen(
            model,
            server,
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
            model, keys, address,
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
            title = { Text(stringResource(R.string.servers_key_title, providerName(provider))) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = key,
                        onValueChange = { key = it },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        supportingText = { Text(stringResource(R.string.servers_key_supporting)) },
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
                }) { Text(stringResource(if (busy) R.string.servers_trying else R.string.servers_save)) }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { settingKey = null }) { Text(stringResource(R.string.servers_cancel)) } },
        )
    }

    if (kit) {
        var passphrase by remember { mutableStateOf("") }
        val kitSubject = stringResource(R.string.servers_kit_subject, hostOf(server))
        val kitKeep = stringResource(R.string.servers_kit_keep)
        AlertDialog(
            onDismissRequest = { kit = false },
            title = { Text(stringResource(R.string.servers_kit_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.servers_kit_body))
                    OutlinedTextField(
                        value = passphrase,
                        onValueChange = { passphrase = it },
                        label = { Text(stringResource(R.string.servers_kit_passphrase)) },
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
                                    .putExtra(Intent.EXTRA_SUBJECT, kitSubject)
                                    .putExtra(Intent.EXTRA_TEXT, text),
                                kitKeep,
                            ),
                        )
                    }
                }) { Text(stringResource(R.string.servers_make_it)) }
            },
            dismissButton = { TextButton(onClick = { kit = false }) { Text(stringResource(R.string.servers_cancel)) } },
        )
    }

    val vm = exeVmName(server)
    if (removing && vm != null) {
        var confirm by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { removing = false },
            title = { Text(stringResource(R.string.servers_remove_title, hostOf(server))) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.servers_remove_body, vm))
                    OutlinedTextField(value = confirm, onValueChange = { confirm = it }, singleLine = true)
                }
            },
            confirmButton = {
                TextButton(enabled = confirm.trim() == vm, onClick = {
                    removing = false
                    scope.launch {
                        try {
                            model.removeExeServer(server)
                            close()
                        } catch (error: Exception) {
                            problem = explain(error)
                        }
                    }
                }) { Text(stringResource(R.string.servers_remove), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { removing = false }) { Text(stringResource(R.string.servers_cancel)) } },
        )
    }

    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val assistantsTitle = stringResource(R.string.servers_assistants)
    val modelKeysTitle = stringResource(R.string.servers_model_keys)
    val serverTitle = stringResource(R.string.servers_server)
    Scaffold(
        containerColor = groupedBackground(),
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            MediumFlexibleTopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(java.net.URI(server).host ?: server) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.servers_back)) } },
                scrollBehavior = scrollBehavior,
            )
        },
    ) { padding ->
        LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = padding.calculateTopPadding(), bottom = 24.dp)) {
            problem?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }
            val current = info ?: return@LazyColumn
            group(
                assistantsTitle,
                current.assistants.map<ServerAssistant, GroupRow> { assistant ->
                    { shapes ->
                        SegmentedListItem(
                            onClick = { editing = assistant },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.SmartToy, null) },
                            supportingContent = {
                                val joined = home == null || (listOfNotNull(home) + places).any { it.account.isAt(server, assistant.name) }
                                Text(
                                    when {
                                        !assistant.running -> stringResource(R.string.servers_not_running)
                                        joined -> assistant.settings.model.modelId
                                        else -> stringResource(R.string.servers_not_joined, assistant.settings.model.modelId)
                                    },
                                )
                            },
                            trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                        ) { Text(assistant.settings.displayName) }
                    }
                } + listOf<GroupRow> { shapes ->
                    SegmentedListItem(
                        onClick = { creating = true },
                        shapes = shapes,
                        leadingContent = { Icon(Icons.Outlined.Add, null) },
                    ) { Text(stringResource(R.string.servers_new_assistant)) }
                },
            )
            item(key = "wired") { WiredCard(model, server) }
            group(
                modelKeysTitle,
                keys.map<ProviderKey, GroupRow> { key ->
                    { shapes ->
                        SegmentedListItem(
                            onClick = { if (key.source != KeySource.ENV) settingKey = key.provider },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Key, null) },
                            supportingContent = {
                                Text(
                                    when (key.source) {
                                        KeySource.ENV -> stringResource(R.string.servers_key_env, key.variables.joinToString())
                                        KeySource.SERVER -> stringResource(R.string.servers_key_server)
                                        KeySource.ASSISTANT -> stringResource(R.string.servers_key_assistant)
                                        KeySource.NONE -> stringResource(R.string.servers_key_none)
                                    },
                                )
                            },
                        ) { Text(providerName(key.provider)) }
                    }
                },
            )
            group(
                serverTitle,
                buildList<GroupRow> {
                    current.updates?.let { updates ->
                        add { shapes ->
                            SegmentedListItem(
                                checked = updates.automatic,
                                onCheckedChange = { on -> act { client.setUpdates(on) } },
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.SystemUpdate, null) },
                                overlineContent = { Text(stringResource(R.string.servers_version, updates.current)) },
                                supportingContent = {
                                    Text(updates.error ?: updates.available?.let { stringResource(R.string.servers_update_out, it) } ?: stringResource(R.string.servers_update_itself))
                                },
                                trailingContent = { Switch(checked = updates.automatic, onCheckedChange = null) },
                            ) { Text(stringResource(R.string.servers_update_automatically)) }
                        }
                    }
                    geo?.let { status ->
                        add { shapes ->
                            SegmentedListItem(
                                onClick = { maps = true },
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.Map, null) },
                                supportingContent = { Text(mapsSummary(status)) },
                            ) { Text(stringResource(R.string.servers_maps)) }
                        }
                    }
                    backups?.let { state ->
                        add { shapes ->
                            SegmentedListItem(
                                onClick = { backingUp = true },
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.Backup, null) },
                                supportingContent = {
                                    Text(backupsSummary(state), color = if (state.lastError != null) MaterialTheme.colorScheme.error else Color.Unspecified)
                                },
                            ) { Text(stringResource(R.string.servers_backups)) }
                        }
                    }
                    add { shapes ->
                        SegmentedListItem(
                            onClick = { kit = true },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Lock, null) },
                            supportingContent = { Text(stringResource(R.string.servers_kit_summary)) },
                        ) { Text(stringResource(R.string.servers_kit_title)) }
                    }
                    add { shapes ->
                        SegmentedListItem(
                            onClick = {
                                scope.launch {
                                    try {
                                        model.removeServer(server)
                                        close()
                                    } catch (error: Exception) {
                                        problem = explain(error)
                                    }
                                }
                            },
                            shapes = shapes,
                            supportingContent = {
                                Text(stringResource(R.string.servers_forget_summary))
                            },
                        ) { Text(stringResource(R.string.servers_forget)) }
                    }
                    if (vm != null && model.servers.exeToken != null) {
                        add { shapes ->
                            SegmentedListItem(
                                onClick = { removing = true },
                                shapes = shapes,
                                supportingContent = {
                                    Text(stringResource(R.string.servers_delete_summary, vm))
                                },
                            ) { Text(stringResource(R.string.servers_delete), color = MaterialTheme.colorScheme.error) }
                        }
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
    model: AppModel,
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
    val home by model.session.collectAsStateWithLifecycle()
    val memberships by model.memberships.collectAsStateWithLifecycle()
    val missing = homeProblem(model)
    // Its home joins it now: it has federation, at an address other servers reach.
    val homeCanJoin = missing == null

    Scaffold(
        topBar = {
            androidx.compose.material3.TopAppBar(
                title = { Text(stringResource(R.string.servers_new_assistant)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.servers_back)) } },
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
                        Text(stringResource(R.string.servers_ready_for, done.assistant.settings.displayName, person), style = MaterialTheme.typography.headlineSmall)
                        Text(stringResource(R.string.servers_ready_send, pairing.code))
                        Button(onClick = {
                            context.startActivity(
                                Intent.createChooser(
                                    Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, pairing.link),
                                    text(R.string.servers_send_link),
                                ),
                            )
                        }) { Text(stringResource(R.string.servers_send_link)) }
                    } else {
                        Text(stringResource(R.string.servers_ready, done.assistant.settings.displayName), style = MaterialTheme.typography.headlineSmall)
                        Text(stringResource(R.string.servers_ready_joined))
                    }
                    TextButton(onClick = close) { Text(stringResource(R.string.servers_done)) }
                    return@Column
                }
                OutlinedTextField(
                    value = name, onValueChange = { name = it }, label = { Text(stringResource(R.string.servers_its_name)) },
                    supportingText = { Text(stringResource(R.string.servers_in_address, slugOf(name).ifEmpty { "…" })) },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                Text(stringResource(R.string.servers_model), style = MaterialTheme.typography.labelLarge)
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
                            if (option in ready) providerName(option) else stringResource(R.string.servers_provider_needs_key, providerName(option)),
                            Modifier.padding(start = 12.dp),
                        )
                    }
                }
                OutlinedTextField(value = modelId, onValueChange = { modelId = it }, label = { Text(stringResource(R.string.servers_model_id)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text(stringResource(R.string.servers_who_for), style = MaterialTheme.typography.labelLarge)
                if (home != null) {
                    Row(Modifier.fillMaxWidth().selectable(selected = forMe, onClick = { forMe = true }), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = forMe, onClick = null)
                        Text(stringResource(R.string.servers_for_me), Modifier.padding(start = 12.dp))
                    }
                }
                Row(Modifier.fillMaxWidth().selectable(selected = !forMe, onClick = { forMe = false }), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = !forMe, onClick = null)
                    Text(stringResource(R.string.servers_for_someone), Modifier.padding(start = 12.dp))
                }
                if (!forMe) {
                    OutlinedTextField(value = person, onValueChange = { person = it }, label = { Text(stringResource(R.string.servers_their_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                } else {
                    HomeFederationCard(model)
                }
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button(
                    enabled = !busy && slugOf(name).isNotEmpty() && modelId.isNotBlank() && (if (forMe) homeCanJoin else person.isNotBlank()),
                    onClick = {
                        busy = true
                        scope.launch {
                            try {
                                made = create(
                                    NewAssistant(
                                        name = slugOf(name),
                                        settings = AssistantSettings(name.trim(), ModelChoice(provider, modelId.trim()), null, null, null),
                                        madeFor = if (forMe) {
                                            AssistantFor.Me(memberships?.address ?: address ?: error(text(R.string.servers_no_address)))
                                        } else {
                                            AssistantFor.SomeonesHome(person.trim())
                                        },
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
                ) { Text(stringResource(if (busy) R.string.servers_making else R.string.servers_make_it)) }
            }
        }
    }
}

/** An assistant's settings, joining it from home, and deleting it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AssistantScreen(
    model: AppModel,
    server: String,
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
    var joining by remember { mutableStateOf(false) }
    val home by model.session.collectAsStateWithLifecycle()
    val places by model.places.collectAsStateWithLifecycle()
    val joined = (listOfNotNull(home) + places).any { it.account.isAt(server, assistant.name) }
    val missing = homeProblem(model)

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
            title = { Text(stringResource(R.string.servers_delete_assistant_title, assistant.settings.displayName)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.servers_delete_assistant_body, assistant.name))
                    OutlinedTextField(value = confirm, onValueChange = { confirm = it }, singleLine = true)
                }
            },
            confirmButton = {
                TextButton(enabled = confirm.trim() == assistant.name, onClick = { deleting = false; act(delete) }) { Text(stringResource(R.string.servers_delete_assistant_confirm)) }
            },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text(stringResource(R.string.servers_cancel)) } },
        )
    }

    Scaffold(
        topBar = {
            androidx.compose.material3.TopAppBar(
                title = { Text(assistant.settings.displayName) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.servers_back)) } },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            OutlinedTextField(value = displayName, onValueChange = { displayName = it }, label = { Text(stringResource(R.string.servers_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(
                value = modelId, onValueChange = { modelId = it },
                label = { Text(stringResource(R.string.servers_model_provider, assistant.settings.model.provider)) },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = instructions, onValueChange = { instructions = it },
                label = { Text(stringResource(R.string.servers_instructions)) },
                supportingText = { Text(stringResource(R.string.servers_instructions_supporting)) },
                minLines = 3, modifier = Modifier.fillMaxWidth(),
            )
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (home != null && !joined) {
                HomeFederationCard(model)
                OutlinedButton(
                    enabled = !joining && missing == null,
                    onClick = {
                        joining = true
                        scope.launch {
                            try {
                                model.joinFromHome(server, assistant.name)
                                problem = null
                            } catch (error: Exception) {
                                problem = explain(error)
                            } finally {
                                joining = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(stringResource(if (joining) R.string.servers_joining else R.string.servers_join_from_home)) }
                Text(
                    stringResource(R.string.servers_join_explainer),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
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
            ) { Text(stringResource(R.string.servers_save)) }
            TextButton(onClick = { deleting = true }) { Text(stringResource(R.string.servers_delete_assistant), color = MaterialTheme.colorScheme.error) }
        }
    }
}
