// The server's backups (ADR 8), for its owners: how they go, and where they are copied off the
// server. They are encrypted before they leave, so the bucket or folder only holds ciphertext.
package app.nudge.ui

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import app.nudge.R
import app.nudge.explain
import app.nudge.text
import kotlinx.coroutines.launch
import nudge.ffi.BackupState
import nudge.ffi.BackupTarget
import nudge.ffi.ServerClient

/** "5 minutes ago", in the phone's language. */
private fun ago(at: Double): String =
    DateUtils.getRelativeTimeSpanString(at.toLong(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()

/** One line on the backups, for the server's screen. */
fun backupsSummary(state: BackupState): String = when {
    !state.on -> text(R.string.servers_backups_off_short)
    state.lastError != null -> text(R.string.servers_backups_failed_short)
    else -> {
        val where = when (val remote = state.remote) {
            is BackupTarget.S3 -> text(R.string.servers_backups_to, remote.bucket)
            is BackupTarget.WebDav -> text(R.string.servers_backups_to, java.net.URI(remote.url).host ?: remote.url)
            null -> text(R.string.servers_backups_here)
        }
        state.lastBackupAt?.let { "$where · ${ago(it)}" } ?: where
    }
}

/** A remote target as the form edits it, credentials included. */
private data class RemoteDraft(
    val s3: Boolean = true,
    val endpoint: String = "",
    val bucket: String = "",
    val region: String = "",
    val prefix: String = "",
    val url: String = "",
    val user: String = "",
    val secret: String = "",
)

private fun draftOf(state: BackupState): RemoteDraft = when (val remote = state.remote) {
    is BackupTarget.S3 -> RemoteDraft(
        endpoint = remote.endpoint,
        bucket = remote.bucket,
        region = remote.region.orEmpty(),
        prefix = remote.prefix.orEmpty(),
        user = state.remoteUser.orEmpty(),
    )
    is BackupTarget.WebDav -> RemoteDraft(s3 = false, url = remote.url, user = state.remoteUser.orEmpty())
    null -> RemoteDraft(user = state.remoteUser.orEmpty())
}

/** What the server is sent for a draft: empty fields left out, so their defaults apply. */
private fun targetOf(draft: RemoteDraft): BackupTarget = if (draft.s3) {
    BackupTarget.S3(
        endpoint = draft.endpoint.trim(),
        bucket = draft.bucket.trim(),
        region = draft.region.trim().ifEmpty { null },
        prefix = draft.prefix.trim().ifEmpty { null },
        pathStyle = null,
    )
} else {
    BackupTarget.WebDav(url = draft.url.trim())
}

@Composable
private fun BackupField(
    value: String,
    label: Int,
    change: (String) -> Unit,
    hint: String? = null,
    placeholder: String? = null,
    secret: Boolean = false,
) = OutlinedTextField(
    value = value,
    onValueChange = change,
    label = { Text(stringResource(label)) },
    placeholder = placeholder?.let { { Text(it) } },
    supportingText = hint?.let { { Text(it) } },
    singleLine = true,
    visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
    keyboardOptions = KeyboardOptions(keyboardType = if (secret) KeyboardType.Password else KeyboardType.Uri),
    modifier = Modifier.fillMaxWidth(),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BackupsScreen(client: ServerClient, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<BackupState?>(null) }
    var draft by remember { mutableStateOf(RemoteDraft()) }
    var busy by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }

    fun saved(next: BackupState) {
        state = next
        draft = draftOf(next)
    }

    fun run(what: String, work: suspend () -> String?) = scope.launch {
        busy = what
        problem = null
        note = null
        try {
            note = work()
        } catch (error: Exception) {
            problem = explain(error)
        } finally {
            busy = null
        }
    }

    LaunchedEffect(client) {
        try {
            saved(client.backups())
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.servers_backups)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.servers_back)) } },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).imePadding().padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Text(stringResource(R.string.servers_backups_intro), style = MaterialTheme.typography.bodyMedium) }
            val backups = state
            if (backups == null) {
                item { Text(problem ?: stringResource(R.string.setup_loading)) }
                return@LazyColumn
            }
            item {
                val status = buildString {
                    append(
                        when {
                            !backups.on -> text(R.string.servers_backups_off)
                            backups.everyHours == 24.0 -> text(R.string.servers_backups_daily, backups.keep.toInt(), backups.dir.orEmpty())
                            else -> text(R.string.servers_backups_every, backups.everyHours.toInt(), backups.keep.toInt(), backups.dir.orEmpty())
                        },
                    )
                    if (backups.on) {
                        append(' ')
                        append(backups.lastBackupAt?.let { text(R.string.servers_backups_newest, ago(it)) } ?: text(R.string.servers_backups_none_made))
                        if (backups.remote != null) {
                            append(' ')
                            append(backups.lastUploadAt?.let { text(R.string.servers_backups_uploaded, ago(it)) } ?: text(R.string.servers_backups_none_uploaded))
                        }
                    }
                }
                Text(status)
            }
            backups.lastError?.let { error ->
                item {
                    Text(
                        backups.lastErrorAt?.let { text(R.string.servers_backups_upload_failed_at, ago(it), error) }
                            ?: text(R.string.servers_backups_upload_failed, error),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            item { Text(stringResource(R.string.servers_backups_copy_to), style = MaterialTheme.typography.titleSmall) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    listOf(true to R.string.servers_backups_s3, false to R.string.servers_backups_webdav).forEach { (s3, label) ->
                        Row(
                            Modifier.selectable(selected = draft.s3 == s3, onClick = { draft = draft.copy(s3 = s3) }),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = draft.s3 == s3, onClick = null)
                            Text(stringResource(label), Modifier.padding(start = 8.dp))
                        }
                    }
                }
            }
            val keptSecret = backups.remoteUser != null && draft.s3 == (backups.remote is BackupTarget.S3) && backups.remote != null
            val keptHint = if (keptSecret) text(R.string.servers_backups_kept) else null
            if (draft.s3) {
                item { BackupField(draft.endpoint, R.string.servers_backups_endpoint, { draft = draft.copy(endpoint = it) }, placeholder = "https://s3.eu-north-1.amazonaws.com") }
                item { BackupField(draft.bucket, R.string.servers_backups_bucket, { draft = draft.copy(bucket = it) }) }
                item { BackupField(draft.region, R.string.servers_backups_region, { draft = draft.copy(region = it) }, hint = text(R.string.servers_backups_region_hint)) }
                item { BackupField(draft.prefix, R.string.servers_backups_prefix, { draft = draft.copy(prefix = it) }, placeholder = "nudge/") }
                item { BackupField(draft.user, R.string.servers_backups_access_key, { draft = draft.copy(user = it) }) }
                item { BackupField(draft.secret, R.string.servers_backups_secret_key, { draft = draft.copy(secret = it) }, placeholder = keptHint, secret = true) }
            } else {
                item { BackupField(draft.url, R.string.servers_backups_url, { draft = draft.copy(url = it) }, placeholder = "https://cloud.example/remote.php/dav/files/me/nudge/") }
                item { BackupField(draft.user, R.string.servers_backups_user, { draft = draft.copy(user = it) }) }
                item {
                    BackupField(draft.secret, R.string.servers_backups_password, { draft = draft.copy(secret = it) }, hint = text(R.string.servers_backups_password_hint), placeholder = keptHint, secret = true)
                }
            }
            if (backups.remoteUserFromEnv) item { Text(stringResource(R.string.servers_backups_from_env), style = MaterialTheme.typography.bodySmall) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = busy == null, onClick = {
                        run("save") {
                            saved(client.setBackupRemote(targetOf(draft), draft.user.trim().ifEmpty { null }, draft.secret.ifEmpty { null }))
                            text(R.string.servers_backups_saved)
                        }
                    }) { Text(stringResource(if (busy == "save") R.string.servers_backups_checking else R.string.servers_backups_check_and_save)) }
                    if (backups.remote != null) {
                        OutlinedButton(enabled = busy == null, onClick = {
                            run("remove") {
                                saved(client.removeBackupRemote())
                                text(R.string.servers_backups_stopped)
                            }
                        }) { Text(stringResource(R.string.servers_backups_stop)) }
                    }
                }
            }
            if (backups.on) {
                item {
                    OutlinedButton(enabled = busy == null, onClick = {
                        run("now") {
                            val made = client.backUpNow()
                            runCatching { client.backups() }.onSuccess { saved(it) }
                            made.uploadError?.let { error(it) }
                            if (backups.remote == null) text(R.string.servers_backups_made, made.file)
                            else text(R.string.servers_backups_made_uploaded, made.file)
                        }
                    }) { Text(stringResource(if (busy == "now") R.string.servers_backups_backing_up else R.string.servers_backups_now)) }
                }
            }
            problem?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
            note?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.primary) } }
        }
    }
}
