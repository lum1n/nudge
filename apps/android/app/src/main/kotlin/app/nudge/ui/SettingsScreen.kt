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
import androidx.compose.material.icons.outlined.QrCode2
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.avatar.look
import app.nudge.avatar.Portrait
import app.nudge.AppModel
import app.nudge.BuildConfig
import app.nudge.Dictation
import app.nudge.R
import app.nudge.Session
import app.nudge.explain
import app.nudge.text
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
    var joiningCluster by remember { mutableStateOf<Session?>(null) }
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
    var robotOf by remember { mutableStateOf<Session?>(null) }
    var peopleOf by remember { mutableStateOf<Session?>(null) }
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
    robotOf?.let { at ->
        BackHandler { robotOf = null }
        RobotScreen(at, close = { robotOf = null })
        return
    }
    peopleOf?.let { at ->
        BackHandler { peopleOf = null }
        PeopleScreen(at, close = { peopleOf = null })
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
        ProfileScreen(model, session, close = { profile = false })
        return
    }

    Scaffold(
        containerColor = groupedBackground(),
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            MediumFlexibleTopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.settings_back)) } },
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
                text(R.string.settings_account),
                listOf(
                    { shapes ->
                        SegmentedListItem(
                            onClick = { profile = true },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.AccountCircle, null) },
                            overlineContent = { Text(stringResource(R.string.settings_signed_in_as)) },
                            supportingContent = { Text(stringResource(R.string.settings_profile_summary)) },
                            trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                        ) { Text(me?.player?.displayName ?: "…") }
                    },
                    { shapes ->
                        SegmentedListItem(
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.SmartToy, null) },
                            overlineContent = { Text(stringResource(R.string.settings_assistant)) },
                        ) { Text(session.account.assistantName) }
                    },
                    { shapes ->
                        SegmentedListItem(
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Dns, null) },
                            overlineContent = { Text(stringResource(R.string.settings_server)) },
                        ) { Text(session.account.server) }
                    },
                ),
            )

            group(
                text(R.string.settings_servers),
                listOf { shapes ->
                    SegmentedListItem(
                        onClick = { servers = ServersPage.List },
                        shapes = shapes,
                        leadingContent = { Icon(Icons.Outlined.Dns, null) },
                        supportingContent = {
                            Text(
                                stringResource(
                                    if (owned.isEmpty()) R.string.settings_servers_none else R.string.settings_servers_some,
                                ),
                            )
                        },
                        trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                    ) {
                        Text(
                            if (owned.isEmpty()) stringResource(R.string.settings_servers)
                            else stringResource(R.string.settings_servers_count, owned.size),
                        )
                    }
                },
            )

            memberships?.let { joined ->
                group(
                    text(R.string.settings_other_assistants),
                    buildList<GroupRow> {
                        add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.AlternateEmail, null) },
                                overlineContent = { Text(stringResource(R.string.settings_your_address)) },
                                supportingContent = { Text(stringResource(R.string.settings_your_address_summary)) },
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
                                    onLongClickLabel = stringResource(R.string.settings_leave),
                                    shapes = shapes,
                                    leadingContent = { Icon(Icons.Outlined.SmartToy, null) },
                                    overlineContent = { Text(java.net.URI(membership.server).host ?: membership.server) },
                                    supportingContent = { Text(stringResource(R.string.settings_carry_memory)) },
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
                    text(R.string.settings_standalone),
                    standalone.map<Session, GroupRow> { place ->
                        { shapes ->
                            // Read so the row changes once the server says who the player is.
                            val placeMe by place.me.collectAsStateWithLifecycle()
                            val canJoin = placeMe != null && memberships != null && model.canJoinCluster(place)
                            SegmentedListItem(
                                onClick = { if (canJoin) joiningCluster = place },
                                onLongClick = { signingOutOf = place },
                                onLongClickLabel = stringResource(R.string.settings_sign_out),
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.SmartToy, null) },
                                overlineContent = { Text(java.net.URI(place.account.server).host ?: place.account.server) },
                                supportingContent = {
                                    Text(
                                        stringResource(
                                            if (canJoin) R.string.settings_standalone_can_join else R.string.settings_standalone_outside,
                                        ),
                                    )
                                },
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
                    if (at === session) {
                        text(R.string.settings_assistant)
                    } else {
                        text(R.string.settings_assistant_on, at.account.assistantName, java.net.URI(at.account.server).host ?: at.account.server)
                    },
                    buildList<GroupRow> {
                        add { shapes ->
                            SegmentedListItem(
                                onClick = { robotOf = at },
                                shapes = shapes,
                                leadingContent = { Portrait(appearance = at.look(), size = 24.dp) },
                                supportingContent = { Text(stringResource(R.string.settings_robot_summary)) },
                                trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                            ) { Text(stringResource(R.string.settings_robot)) }
                        }
                        add { shapes ->
                            SegmentedListItem(
                                onClick = { extensionsOf = at },
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.Extension, null) },
                                supportingContent = { Text(stringResource(R.string.settings_extensions_summary)) },
                                trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                            ) { Text(stringResource(R.string.settings_extensions)) }
                        }
                        add { shapes ->
                            SegmentedListItem(
                                onClick = { peopleOf = at },
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.QrCode2, null) },
                                supportingContent = { Text(stringResource(R.string.settings_people_summary)) },
                                trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                            ) { Text(stringResource(R.string.settings_people)) }
                        }
                        // Without federation at home there are no memberships; joined ones have it.
                        if (if (at === session) memberships != null else !at.account.standalone) {
                            add { shapes ->
                                SegmentedListItem(
                                    onClick = { invitesOf = at },
                                    shapes = shapes,
                                    leadingContent = { Icon(Icons.Outlined.PersonAdd, null) },
                                    supportingContent = { Text(stringResource(R.string.settings_invites_summary)) },
                                    trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                                ) { Text(stringResource(R.string.settings_invites)) }
                            }
                        }
                    },
                )
            }

            val mine = memory
            group(
                text(R.string.settings_memory),
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
                            supportingContent = { Text(stringResource(R.string.settings_memory_share_summary)) },
                            trailingContent = { Switch(checked = mine.shared, onCheckedChange = null) },
                        ) { Text(stringResource(R.string.settings_memory_share)) }
                    }
                    mine.facts.forEach { fact ->
                        add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                trailingContent = {
                                    IconButton(onClick = { change { client.forgetForMe(fact.id) } }) {
                                        Icon(Icons.Outlined.Close, stringResource(R.string.settings_forget))
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
                    placeholder = { Text(stringResource(R.string.settings_remember_placeholder)) },
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
                text(R.string.settings_hidden),
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
                                    Text(stringResource(R.string.settings_hidden_none_summary))
                                },
                            ) { Text(stringResource(R.string.settings_hidden_none)) }
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
                                        Icon(Icons.Outlined.Close, stringResource(R.string.settings_hidden_forget))
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
                    placeholder = { Text(stringResource(R.string.settings_hidden_placeholder)) },
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
                    text(R.string.settings_spend),
                    buildList<GroupRow> {
                        fun row(label: String, value: Double) = add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.Payments, null) },
                                trailingContent = { Text(dollars(value), style = MaterialTheme.typography.titleMedium) },
                            ) { Text(label) }
                        }
                        row(text(R.string.settings_spend_mine), spend.mine)
                        row(text(R.string.settings_spend_everyone), spend.total)
                        spend.perPlayerUsd?.let { row(text(R.string.settings_spend_your_limit), it) }
                        spend.monthlyUsd?.let { row(text(R.string.settings_spend_monthly_limit), it) }
                    },
                )
            }

            group(
                text(R.string.settings_speech),
                listOf { shapes ->
                    SegmentedListItem(
                        onClick = { speech = true },
                        shapes = shapes,
                        leadingContent = { Icon(Icons.Outlined.Mic, null) },
                        supportingContent = { Text(speechLanguages.joinToString { Dictation.displayName(it) }) },
                        trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                    ) { Text(stringResource(R.string.settings_speech_languages)) }
                },
            )

            group(
                text(R.string.settings_notifications),
                listOf(
                    { shapes ->
                        SegmentedListItem(
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Notifications, null) },
                            supportingContent = {
                                Text(stringResource(R.string.settings_notifications_summary))
                            },
                        ) {
                            Text(
                                stringResource(
                                    when {
                                        !BuildConfig.FIREBASE -> R.string.settings_notifications_no_build
                                        !notificationsOn -> R.string.settings_notifications_off
                                        platforms?.fcm != true -> R.string.settings_notifications_no_server
                                        else -> R.string.settings_notifications_on
                                    },
                                ),
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
                    Text(stringResource(R.string.settings_sign_out))
                }
            }
        }
    }

    leaving?.let { membership ->
        AlertDialog(
            onDismissRequest = { leaving = null },
            title = { Text(stringResource(R.string.settings_leave_title, membership.assistant)) },
            text = {
                Text(stringResource(R.string.settings_leave_text))
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
                }) { Text(stringResource(R.string.settings_leave)) }
            },
            dismissButton = { TextButton(onClick = { leaving = null }) { Text(stringResource(R.string.settings_cancel)) } },
        )
    }

    joiningCluster?.let { place ->
        AlertDialog(
            onDismissRequest = { joiningCluster = null },
            title = { Text(stringResource(R.string.settings_join_cluster_title, place.account.assistantName)) },
            text = {
                Text(stringResource(R.string.settings_join_cluster_text))
            },
            confirmButton = {
                TextButton(onClick = {
                    joiningCluster = null
                    scope.launch {
                        try {
                            model.joinCluster(place)
                            problem = null
                        } catch (error: Exception) {
                            problem = explain(error)
                        }
                    }
                }) { Text(stringResource(R.string.settings_join_cluster)) }
            },
            dismissButton = { TextButton(onClick = { joiningCluster = null }) { Text(stringResource(R.string.settings_cancel)) } },
        )
    }

    signingOutOf?.let { place ->
        AlertDialog(
            onDismissRequest = { signingOutOf = null },
            title = { Text(stringResource(R.string.settings_sign_out_of_title, place.account.assistantName)) },
            text = { Text(stringResource(R.string.settings_sign_out_of_text)) },
            confirmButton = {
                TextButton(onClick = {
                    signingOutOf = null
                    scope.launch { model.signOutOf(place) }
                }) { Text(stringResource(R.string.settings_sign_out)) }
            },
            dismissButton = { TextButton(onClick = { signingOutOf = null }) { Text(stringResource(R.string.settings_cancel)) } },
        )
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            icon = { Icon(Icons.AutoMirrored.Outlined.Logout, null) },
            title = { Text(stringResource(R.string.settings_sign_out_of_title, session.account.assistantName)) },
            text = { Text(stringResource(R.string.settings_sign_out_home_text)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmSignOut = false
                    scope.launch { model.signOut() }
                }) { Text(stringResource(R.string.settings_sign_out)) }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text(stringResource(R.string.settings_cancel)) } },
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
