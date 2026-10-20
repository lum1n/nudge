package app.nudge.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MediumFlexibleTopAppBar
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.AppModel
import app.nudge.BuildConfig
import app.nudge.Dictation
import app.nudge.Session
import app.nudge.explain
import java.text.NumberFormat
import java.util.Currency
import kotlinx.coroutines.launch
import nudge.ffi.Membership
import nudge.ffi.PlayerMemory
import nudge.ffi.PrivateValue
import nudge.ffi.Usage

/**
 * The account, the extensions and invites of each assistant the player is an admin of, the
 * player's own memory, this month's spend, notifications, and signing out.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun SettingsScreen(model: AppModel, session: Session, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val me by session.me.collectAsStateWithLifecycle()
    val platforms by session.pushPlatforms.collectAsStateWithLifecycle()
    val memberships by model.memberships.collectAsStateWithLifecycle()
    var leaving by remember { mutableStateOf<Membership?>(null) }
    var signingOutOf by remember { mutableStateOf<Session?>(null) }
    var profile by rememberSaveable { mutableStateOf(false) }
    var speech by rememberSaveable { mutableStateOf(false) }
    val speechLanguages by model.dictation.languages.collectAsStateWithLifecycle()
    val client = session.client
    var memory by remember { mutableStateOf<PlayerMemory?>(null) }
    var hidden by remember { mutableStateOf<List<PrivateValue>?>(null) }
    var newHidden by remember { mutableStateOf("") }
    var usage by remember { mutableStateOf<Usage?>(null) }
    var newFact by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    var confirmSignOut by remember { mutableStateOf(false) }
    var servers by remember { mutableStateOf<ServersPage?>(null) }
    val owned by model.servers.owned.collectAsStateWithLifecycle()
    val notificationsOn = NotificationManagerCompat.from(LocalContext.current).areNotificationsEnabled()
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    // The assistant whose extensions or invites are open: home, or one joined from there.
    var extensionsOf by remember { mutableStateOf<Session?>(null) }
    var invitesOf by remember { mutableStateOf<Session?>(null) }
    val places by model.places.collectAsStateWithLifecycle()
    val administered = places.filter { place ->
        key(place.account.key) { place.me.collectAsStateWithLifecycle().value?.admin == true }
    }

    fun change(action: suspend () -> Unit) = scope.launch {
        try {
            action()
            memory = client.myMemory()
            hidden = client.privateValues()
            problem = null
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    LaunchedEffect(client) {
        try {
            memory = client.myMemory()
            hidden = client.privateValues()
            usage = client.usage()
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    extensionsOf?.let { at ->
        BackHandler { extensionsOf = null }
        ExtensionsScreen(at.client, close = { extensionsOf = null })
        return
    }
    invitesOf?.let { at ->
        BackHandler { invitesOf = null }
        InvitesScreen(at.client, at.account.assistantName, close = { invitesOf = null })
        return
    }
    servers?.let { screen ->
        BackHandler { servers = null }
        when (screen) {
            is ServersPage.List -> ServersScreen(
                model, memberships?.address,
                exe = { servers = ServersPage.Exe },
                close = { servers = null },
            )
            is ServersPage.Exe -> ExeScreen(
                model,
                close = { servers = ServersPage.List },
                ready = { servers = ServersPage.Setup(it) },
            )
            is ServersPage.Setup -> SetupScreen(model, screen.start, close = { servers = ServersPage.List })
        }
        return
    }
    if (speech) {
        BackHandler { speech = false }
        SpeechScreen(model.dictation, close = { speech = false })
        return
    }
    if (profile) {
        BackHandler { profile = false }
        ProfileScreen(session, close = { profile = false })
        return
    }

    Scaffold(
        containerColor = groupedBackground(),
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            MediumFlexibleTopAppBar(
                colors = groupedTopBarColors(),
                title = { Text("Settings") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                scrollBehavior = scrollBehavior,
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.imePadding(),
            contentPadding = PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = padding.calculateTopPadding(),
                bottom = padding.calculateBottomPadding() + 24.dp,
            ),
        ) {
            group(
                "Account",
                listOf(
                    { shapes ->
                        SegmentedListItem(
                            onClick = { profile = true },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.AccountCircle, null) },
                            overlineContent = { Text("Signed in as") },
                            supportingContent = { Text("Your name, picture, time zone and language") },
                            trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                        ) { Text(me?.player?.displayName ?: "…") }
                    },
                    { shapes ->
                        SegmentedListItem(
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.SmartToy, null) },
                            overlineContent = { Text("Assistant") },
                        ) { Text(session.account.assistantName) }
                    },
                    { shapes ->
                        SegmentedListItem(
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Dns, null) },
                            overlineContent = { Text("Server") },
                        ) { Text(session.account.server) }
                    },
                ),
            )

            group(
                "Servers",
                listOf { shapes ->
                    SegmentedListItem(
                        onClick = { servers = ServersPage.List },
                        shapes = shapes,
                        leadingContent = { Icon(Icons.Outlined.Dns, null) },
                        supportingContent = {
                            Text(
                                if (owned.isEmpty()) "Make your own on exe.dev, and assistants on it"
                                else "Yours: their assistants, model keys and updates",
                            )
                        },
                        trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                    ) { Text(if (owned.isEmpty()) "Servers" else "Servers (${owned.size})") }
                },
            )

            memberships?.let { joined ->
                group(
                    "Other assistants",
                    buildList<GroupRow> {
                        add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.AlternateEmail, null) },
                                overlineContent = { Text("Your address") },
                                supportingContent = { Text("An admin of another assistant invites you by it; the invite opens here.") },
                            ) { Text(joined.address) }
                        }
                        joined.memberships.forEach { membership ->
                            add { shapes ->
                                SegmentedListItem(
                                    checked = membership.carryMemory,
                                    onCheckedChange = { carry ->
                                        scope.launch {
                                            try {
                                                model.carryMemory(membership, carry)
                                            } catch (error: Exception) {
                                                problem = explain(error)
                                            }
                                        }
                                    },
                                    onLongClick = { leaving = membership },
                                    onLongClickLabel = "Leave",
                                    shapes = shapes,
                                    leadingContent = { Icon(Icons.Outlined.SmartToy, null) },
                                    overlineContent = { Text(java.net.URI(membership.server).host ?: membership.server) },
                                    supportingContent = { Text("Take my own memory there, but not what only I see. Long press to leave.") },
                                    trailingContent = { Switch(checked = membership.carryMemory, onCheckedChange = null) },
                                ) { Text(membership.assistant) }
                            }
                        }
                    },
                )
            }

            val standalone = places.filter { it.account.standalone }
            if (standalone.isNotEmpty()) {
                group(
                    "On their own",
                    standalone.map<Session, GroupRow> { place ->
                        { shapes ->
                            SegmentedListItem(
                                onClick = {},
                                onLongClick = { signingOutOf = place },
                                onLongClickLabel = "Sign out",
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.SmartToy, null) },
                                overlineContent = { Text(java.net.URI(place.account.server).host ?: place.account.server) },
                                supportingContent = { Text("Outside your cluster, without federation: you are a person of its own. Long press to sign out.") },
                            ) { Text(place.account.assistantName) }
                        }
                    },
                )
            }

            // Home first, then the assistants joined from it where the player is an admin too.
            val admin = listOfNotNull(session.takeIf { me?.admin == true }) + administered
            admin.forEach { at ->
                group(
                    // Titles key the list, and assistants on different servers may share a name.
                    if (at === session) "Assistant" else "${at.account.assistantName} on ${java.net.URI(at.account.server).host ?: at.account.server}",
                    buildList<GroupRow> {
                        add { shapes ->
                            SegmentedListItem(
                                onClick = { extensionsOf = at },
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.Extension, null) },
                                supportingContent = { Text("Turn them on or off and change their settings, for every room") },
                                trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                            ) { Text("Extensions") }
                        }
                        // Without federation at home there are no memberships; joined ones have it.
                        if (if (at === session) memberships != null else !at.account.standalone) {
                            add { shapes ->
                                SegmentedListItem(
                                    onClick = { invitesOf = at },
                                    shapes = shapes,
                                    leadingContent = { Icon(Icons.Outlined.PersonAdd, null) },
                                    supportingContent = { Text("Let someone from another assistant join, by their address") },
                                    trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                                ) { Text("Invites") }
                            }
                        }
                    },
                )
            }

            val mine = memory
            group(
                "My memory",
                buildList<GroupRow> {
                    if (mine == null) {
                        add { _ -> LoadingIndicator(Modifier.padding(16.dp)) }
                        return@buildList
                    }
                    add { shapes ->
                        SegmentedListItem(
                            checked = mine.shared,
                            onCheckedChange = { shared -> change { client.shareMyMemory(shared) } },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Share, null) },
                            supportingContent = { Text("Every room you're in sees these facts, and the assistant there too.") },
                            trailingContent = { Switch(checked = mine.shared, onCheckedChange = null) },
                        ) { Text("Share with all my rooms") }
                    }
                    mine.facts.forEach { fact ->
                        add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                trailingContent = {
                                    IconButton(onClick = { change { client.forgetForMe(fact.id) } }) {
                                        Icon(Icons.Outlined.Close, "Forget")
                                    }
                                },
                            ) { Text(fact.text) }
                        }
                    }
                },
            )
            item {
                OutlinedTextField(
                    value = newFact,
                    onValueChange = { newFact = it },
                    placeholder = { Text("Remember about me…") },
                    singleLine = true,
                    shape = MaterialTheme.shapes.large,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        val text = newFact.trim()
                        if (text.isNotEmpty()) {
                            newFact = ""
                            change { client.rememberForMe(text) }
                        }
                    }),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
            }

            // Values only this player sees: everyone else, and the model, get a placeholder.
            group(
                "Only you see",
                buildList<GroupRow> {
                    val values = hidden
                    if (values == null) {
                        add { _ -> LoadingIndicator(Modifier.padding(16.dp)) }
                        return@buildList
                    }
                    if (values.isEmpty()) {
                        add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.Lock, null) },
                                supportingContent = {
                                    Text("Hide an address, a name or a number: the others and the assistant see it as hidden, in every room.")
                                },
                            ) { Text("Nothing hidden yet") }
                        }
                    }
                    values.forEach { value ->
                        add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.Lock, null) },
                                trailingContent = {
                                    // Forgotten for good: from then on everyone sees only the placeholder.
                                    IconButton(onClick = { change { client.forgetValue(value.placeholder) } }) {
                                        Icon(Icons.Outlined.Close, "Forget for good")
                                    }
                                },
                            ) { Text(value.value) }
                        }
                    }
                },
            )
            item {
                OutlinedTextField(
                    value = newHidden,
                    onValueChange = { newHidden = it },
                    placeholder = { Text("Hide a value…") },
                    singleLine = true,
                    shape = MaterialTheme.shapes.large,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        val text = newHidden.trim()
                        if (text.length >= 2) {
                            newHidden = ""
                            change { client.protect(text, null, true) }
                        }
                    }),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
            }

            usage?.let { spend ->
                group(
                    "This month",
                    buildList<GroupRow> {
                        fun row(label: String, value: Double) = add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.Payments, null) },
                                trailingContent = { Text(dollars(value), style = MaterialTheme.typography.titleMedium) },
                            ) { Text(label) }
                        }
                        row("Your messages", spend.mine)
                        row("Everyone", spend.total)
                        spend.perPlayerUsd?.let { row("Your limit", it) }
                        spend.monthlyUsd?.let { row("Monthly limit", it) }
                    },
                )
            }

            group(
                "Speech",
                listOf { shapes ->
                    SegmentedListItem(
                        onClick = { speech = true },
                        shapes = shapes,
                        leadingContent = { Icon(Icons.Outlined.Mic, null) },
                        supportingContent = { Text(speechLanguages.joinToString { Dictation.displayName(it) }) },
                        trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                    ) { Text("Languages you speak") }
                },
            )

            group(
                "Notifications",
                listOf(
                    { shapes ->
                        SegmentedListItem(
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Notifications, null) },
                            supportingContent = {
                                Text("When an answer is ready or an action waits for your approval, while the app is closed.")
                            },
                        ) {
                            Text(
                                when {
                                    !BuildConfig.FIREBASE -> "Not in this build"
                                    !notificationsOn -> "Off in the phone's settings"
                                    platforms?.fcm != true -> "Not sent by this server"
                                    else -> "On"
                                },
                            )
                        }
                    },
                ),
            )

            problem?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 16.dp)) } }
            item {
                Button(
                    onClick = { confirmSignOut = true },
                    shapes = ButtonDefaults.shapes(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    ),
                    modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
                ) {
                    Icon(Icons.AutoMirrored.Outlined.Logout, null, Modifier.padding(end = 8.dp))
                    Text("Sign out")
                }
            }
        }
    }

    leaving?.let { membership ->
        AlertDialog(
            onDismissRequest = { leaving = null },
            title = { Text("Leave ${membership.assistant}?") },
            text = {
                Text("Your home stops sending it your profile and memory, and this device signs out of it. You stay a member there.")
            },
            confirmButton = {
                TextButton(onClick = {
                    leaving = null
                    scope.launch {
                        try {
                            model.leave(membership)
                        } catch (error: Exception) {
                            problem = explain(error)
                        }
                    }
                }) { Text("Leave") }
            },
            dismissButton = { TextButton(onClick = { leaving = null }) { Text("Cancel") } },
        )
    }

    signingOutOf?.let { place ->
        AlertDialog(
            onDismissRequest = { signingOutOf = null },
            title = { Text("Sign out of ${place.account.assistantName}?") },
            text = { Text("You'll need a new pairing code from it to sign in again.") },
            confirmButton = {
                TextButton(onClick = {
                    signingOutOf = null
                    scope.launch { model.signOutOf(place) }
                }) { Text("Sign out") }
            },
            dismissButton = { TextButton(onClick = { signingOutOf = null }) { Text("Cancel") } },
        )
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            icon = { Icon(Icons.AutoMirrored.Outlined.Logout, null) },
            title = { Text("Sign out of ${session.account.assistantName}?") },
            text = { Text("This device signs out of the assistants you joined from there too. You'll need a new pairing code to sign in again.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmSignOut = false
                    scope.launch { model.signOut() }
                }) { Text("Sign out") }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

private fun dollars(value: Double): String =
    NumberFormat.getCurrencyInstance().apply { currency = Currency.getInstance("USD") }.format(value)

/** The servers pages over Settings: the list, making one on exe.dev, and setting it up. */
private sealed interface ServersPage {
    data object List : ServersPage
    data object Exe : ServersPage
    data class Setup(val start: SetupStart) : ServersPage
}
