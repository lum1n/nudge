package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
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
import kotlinx.coroutines.launch
import nudge.ffi.Approval
import nudge.ffi.ClientAction
import nudge.ffi.ExeClient

/**
 * A pending approval in the room, decided here: what it asks for typed in (a secret one hidden
 * while typed), and what the app does first with the device's exe.dev token ([exeToken]), such as
 * making a VM. What is typed is only held while the card shows, sent with the yes, and cleared
 * once sent. A failure is shown and the approval stays pending, to try again or deny.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PendingApprovalCard(
    approval: Approval,
    exeToken: String?,
    decide: suspend (approve: Boolean, inputs: Map<String, String>?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    // Not saveable: values never go into the saved instance state.
    val values = remember(approval.id) { mutableStateMapOf<String, String>() }
    var busy by remember(approval.id) { mutableStateOf(false) }
    /** What it is doing, while it does it. */
    var progress by remember(approval.id) { mutableStateOf<Int?>(null) }
    var problem by remember(approval.id) { mutableStateOf<String?>(null) }
    /** What the client action gave, once it ran: trying again then only approves. */
    var actionInputs by remember(approval.id) { mutableStateOf<Map<String, String>?>(null) }
    val action = approval.clientAction
    val missing = approval.inputs.any { !it.optional && values[it.name].isNullOrBlank() }
    val blocked = action != null && actionInputs == null && exeToken == null

    fun send(approve: Boolean) {
        if (busy) return
        busy = true
        progress = when {
            !approve -> null
            actionInputs != null -> R.string.approval_approving
            action is ClientAction.ExeNew -> R.string.approval_making_vm
            action is ClientAction.ExeRm -> R.string.approval_deleting_vm
            else -> R.string.approval_approving
        }
        problem = null
        scope.launch {
            try {
                if (!approve) {
                    decide(false, null)
                    return@launch
                }
                val typed = approval.inputs.mapNotNull { input ->
                    values[input.name]?.takeIf { it.isNotEmpty() }?.let { input.name to it }
                }.toMap()
                val done = actionInputs ?: when {
                    action == null -> emptyMap()
                    exeToken == null -> return@launch
                    else -> ExeClient(exeToken).use { it.runClientAction(action) }.also { actionInputs = it }
                }
                progress = R.string.approval_approving
                val inputs = typed + done
                try {
                    decide(true, inputs.ifEmpty { null })
                } finally {
                    // Sent once, then gone from here, whatever the answer.
                    values.clear()
                }
            } catch (error: Exception) {
                problem = explain(error)
            } finally {
                busy = false
                progress = null
            }
        }
    }

    Surface(
        shape = MaterialTheme.shapes.extraLarge,
        color = MaterialTheme.colorScheme.tertiaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.PanTool, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.tertiary)
                Text(
                    stringResource(R.string.room_needs_approval),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
            Text(withHidden(approval.summary))
            approval.inputs.forEach { input ->
                OutlinedTextField(
                    value = values[input.name].orEmpty(),
                    onValueChange = { values[input.name] = it },
                    label = {
                        Text(if (input.optional) stringResource(R.string.approval_optional, input.label) else input.label)
                    },
                    supportingText = input.description?.let { { Text(it) } },
                    singleLine = true,
                    enabled = !busy,
                    visualTransformation = if (input.secret) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = if (input.secret) {
                        KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false)
                    } else {
                        KeyboardOptions.Default
                    },
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (blocked) {
                Text(
                    stringResource(R.string.approval_needs_exe),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                )
            }
            problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            progress?.let { doing ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    LoadingIndicator(Modifier.size(24.dp))
                    Text(stringResource(doing), style = MaterialTheme.typography.bodySmall)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { send(true) },
                    enabled = !busy && !missing && !blocked,
                    shapes = ButtonDefaults.shapes(),
                ) {
                    Icon(
                        if (action == null) Icons.Outlined.Check else Icons.Outlined.Cloud,
                        null,
                        Modifier.size(ButtonDefaults.IconSize),
                    )
                    Spacer(Modifier.size(ButtonDefaults.IconSpacing))
                    Text(
                        when (action) {
                            is ClientAction.ExeNew -> stringResource(R.string.approval_launch_vm, action.name)
                            is ClientAction.ExeRm -> stringResource(R.string.approval_delete_vm, action.name)
                            null -> stringResource(R.string.room_approve)
                        },
                    )
                }
                OutlinedButton(
                    onClick = { send(false) },
                    enabled = !busy,
                    shapes = ButtonDefaults.shapes(),
                ) { Text(stringResource(R.string.room_deny)) }
            }
        }
    }
}
