package app.nudge.ui

import android.content.Intent
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.nudge.R
import app.nudge.explain
import app.nudge.text
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.launch
import nudge.ffi.Invite
import nudge.ffi.InviteLink
import nudge.ffi.NudgeClient
import nudge.ffi.NudgeException

/**
 * People from other assistants an admin lets join this one, by their address: the open invites,
 * a new one, and the link to send the person, which opens in their app.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun InvitesScreen(client: NudgeClient, assistantName: String, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var invites by remember { mutableStateOf<List<Invite>?>(null) }
    var address by remember { mutableStateOf("") }
    var made by remember { mutableStateOf<InviteLink?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }

    fun share(link: InviteLink) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text(R.string.settings_invites_share, assistantName, link.link))
        }
        context.startActivity(Intent.createChooser(send, text(R.string.settings_invites_send)))
    }

    fun change(action: suspend () -> Unit) = scope.launch {
        try {
            action()
            invites = client.invites()
            problem = null
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    LaunchedEffect(client) {
        try {
            invites = client.invites()
        } catch (error: Exception) {
            problem = if (error is NudgeException.Status && error.status.toInt() == 404) {
                text(R.string.settings_invites_not_open)
            } else {
                explain(error)
            }
        }
    }

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(stringResource(R.string.settings_invites)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.settings_back)) } },
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
            item {
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it },
                    label = { Text(stringResource(R.string.settings_invites_their_address)) },
                    placeholder = { Text("ann@nudge.example.com/robin") },
                    supportingText = {
                        Text(stringResource(R.string.settings_invites_help))
                    },
                    singleLine = true,
                    shape = MaterialTheme.shapes.large,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = {
                        val text = address.trim()
                        if (text.isNotEmpty()) {
                            change {
                                val link = client.invite(text)
                                address = ""
                                made = link
                                share(link)
                            }
                        }
                    }),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
            }
            problem?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp)) } }

            val open = invites
            group(
                text(R.string.settings_invites_waiting),
                buildList<GroupRow> {
                    if (open == null) {
                        if (problem == null) add { _ -> LoadingIndicator(Modifier.padding(16.dp)) }
                        return@buildList
                    }
                    if (open.isEmpty()) {
                        add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.AlternateEmail, null) },
                            ) { Text(stringResource(R.string.settings_invites_none)) }
                        }
                    }
                    open.forEach { invite ->
                        add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                leadingContent = { Icon(Icons.Outlined.AlternateEmail, null) },
                                supportingContent = { Text(stringResource(R.string.settings_invites_until, until(invite.expiresAt))) },
                                trailingContent = {
                                    Row {
                                        // For the invite just made; its link only names this assistant.
                                        made?.takeIf { it.invite.id == invite.id }?.let { link ->
                                            IconButton(onClick = { share(link) }) { Icon(Icons.Outlined.Share, stringResource(R.string.settings_send_link)) }
                                        }
                                        IconButton(onClick = { change { client.cancelInvite(invite.id) } }) {
                                            Icon(Icons.Outlined.Close, stringResource(R.string.settings_invites_cancel))
                                        }
                                    }
                                },
                            ) { Text(invite.address) }
                        }
                    }
                },
            )
        }
    }
}

private fun until(at: Double): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(at.toLong()))
