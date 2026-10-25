package app.nudge.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.Share
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.R
import app.nudge.Session
import app.nudge.explain
import app.nudge.text
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import nudge.client.PairingLink
import nudge.ffi.PairingCode

/** A pairing code an admin made: whom it signs in, and whether that is the admin themselves. */
data class Pairing(val code: PairingCode, val displayName: String, val self: Boolean) {
    /** The server the link names, which the app's sign-in asks for beside the code. */
    val server: String? get() = PairingLink.parse(code.link)?.server

    /** What to do with it, said to the admin. */
    val hint: String
        get() {
            val who = if (self) text(R.string.settings_pairing_hint_self) else text(R.string.settings_pairing_hint_other, displayName)
            return listOfNotNull(who, server?.let { text(R.string.settings_pairing_server, it) }).joinToString(" ")
        }

    /** What the share sheet sends: the link, which opens the app, and the code to type. */
    fun message(assistantName: String): String {
        val type = server?.let { text(R.string.settings_pairing_message_code_at, code.code, it) }
            ?: text(R.string.settings_pairing_message_code, code.code)
        return text(R.string.settings_pairing_message, assistantName, displayName, code.link) + "\n" + type
    }
}

/**
 * Pairing codes, each with its QR code, from an admin: for someone new, made a player first, or
 * for another device of the admin's own. The QR code holds the `nudge://pair` link that
 * `nudge pair` prints, which the apps scan.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PeopleScreen(session: Session, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val me by session.me.collectAsStateWithLifecycle()
    val client = session.client
    var name by remember { mutableStateOf("") }
    var pairing by remember { mutableStateOf<Pairing?>(null) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    fun make(action: suspend () -> Pairing) = scope.launch {
        busy = true
        problem = null
        try {
            pairing = action()
        } catch (error: Exception) {
            problem = explain(error)
        } finally {
            busy = false
        }
    }

    fun invite() {
        val displayName = name.trim()
        if (displayName.isEmpty()) return
        make {
            val player = client.createPlayer(displayName)
            name = ""
            Pairing(client.pairingCode(player.id), player.displayName, self = false)
        }
    }

    fun anotherDevice() {
        val self = me?.player ?: return
        make { Pairing(client.pairingCode(self.id), self.displayName, self = true) }
    }

    fun share(made: Pairing) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, made.message(session.account.assistantName))
        }
        context.startActivity(Intent.createChooser(send, text(R.string.settings_send_link)))
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_people)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.settings_back)) } },
            )
        },
    ) { padding ->
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
                val made = pairing
                if (made != null) {
                    PairingCard(made, share = { share(made) }, done = { pairing = null })
                    return@Column
                }
                Text(
                    stringResource(R.string.settings_pairing_intro),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.settings_pairing_their_name)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { invite() }),
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth(),
                )
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) {
                    LoadingIndicator(Modifier.align(Alignment.CenterHorizontally))
                } else {
                    Button(
                        onClick = { invite() },
                        enabled = name.isNotBlank(),
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Outlined.PersonAdd, null, Modifier.padding(end = 8.dp))
                        Text(stringResource(R.string.settings_pairing_invite))
                    }
                    OutlinedButton(
                        onClick = { anotherDevice() },
                        enabled = me != null,
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Outlined.Devices, null, Modifier.padding(end = 8.dp))
                        Text(stringResource(R.string.settings_pairing_another_device))
                    }
                }
            }
        }
    }
}

/** The code, the QR code of its link, and until when it works; gone once it expired. */
@Composable
private fun PairingCard(pairing: Pairing, share: () -> Unit, done: () -> Unit) {
    var expired by remember(pairing) { mutableStateOf(pairing.code.expiresAt <= System.currentTimeMillis()) }
    LaunchedEffect(pairing) {
        delay((pairing.code.expiresAt.toLong() - System.currentTimeMillis()).coerceAtLeast(0))
        expired = true
    }
    Text(pairing.hint)
    if (expired) {
        Text(stringResource(R.string.settings_pairing_expired), color = MaterialTheme.colorScheme.error)
    } else {
        Surface(
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surfaceContainerHighest,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                QrCode(
                    pairing.code.link,
                    stringResource(R.string.settings_pairing_qr, pairing.displayName),
                    Modifier.fillMaxWidth(0.8f),
                )
                Text(
                    pairing.code.code,
                    style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.padding(top = 16.dp),
                )
            }
        }
        Text(
            stringResource(R.string.settings_pairing_works_until, until(pairing.code.expiresAt), pairing.displayName),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!expired) {
            Button(onClick = share, shapes = ButtonDefaults.shapes()) {
                Icon(Icons.Outlined.Share, null, Modifier.padding(end = 8.dp))
                Text(stringResource(R.string.settings_send_link))
            }
        }
        TextButton(onClick = done) { Text(stringResource(R.string.settings_pairing_done)) }
    }
}

private fun until(at: Double): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at.toLong()))
