package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.nudge.R
import app.nudge.explain
import kotlinx.coroutines.launch
import nudge.ffi.KeySource
import nudge.ffi.ModelChoice
import nudge.ffi.ServerModelProvider

/**
 * The model an assistant answers with, picked from the server's catalog: a provider, then one of
 * its models, with where that provider's key comes from. A provider with no key anywhere gets a
 * field for the server's key, tried once before it is kept. Without a catalog (an older server),
 * the model id is typed instead.
 */
@Composable
fun ModelPicker(
    catalog: List<ServerModelProvider>?,
    chosen: ModelChoice,
    pick: (ModelChoice) -> Unit,
    setKey: suspend (provider: String, key: String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.servers_model), style = MaterialTheme.typography.labelLarge)
        if (catalog == null) {
            OutlinedTextField(
                value = chosen.modelId, onValueChange = { pick(chosen.copy(modelId = it)) },
                label = { Text(stringResource(R.string.servers_model_provider, chosen.provider)) },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            return@Column
        }
        val provider = catalog.firstOrNull { it.id == chosen.provider }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Menu(
                label = provider?.name ?: chosen.provider,
                options = catalog.map { it.id to it.name },
                modifier = Modifier.weight(1f),
            ) { id -> pick(ModelChoice(id, catalog.first { it.id == id }.models.firstOrNull()?.id.orEmpty())) }
            Menu(
                label = provider?.models?.firstOrNull { it.id == chosen.modelId }?.name ?: chosen.modelId.ifEmpty { "—" },
                options = provider?.models?.map { it.id to it.name }.orEmpty(),
                modifier = Modifier.weight(1f),
            ) { id -> pick(chosen.copy(modelId = id)) }
        }
        val key = provider?.key ?: return@Column
        Text(
            when (key.source) {
                KeySource.ENV -> stringResource(R.string.servers_model_key_env, key.variables.joinToString(", "))
                KeySource.SERVER -> stringResource(R.string.servers_model_key_server)
                KeySource.ASSISTANT -> stringResource(R.string.servers_model_key_assistant)
                KeySource.NONE -> stringResource(R.string.servers_model_key_none, provider.name)
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (key.source == KeySource.NONE) {
            var entered by remember(provider.id) { mutableStateOf("") }
            var busy by remember { mutableStateOf(false) }
            var problem by remember { mutableStateOf<String?>(null) }
            OutlinedTextField(
                value = entered,
                onValueChange = { entered = it },
                label = { Text(stringResource(R.string.servers_key_title, provider.name)) },
                supportingText = { Text(problem ?: stringResource(R.string.servers_key_supporting)) },
                isError = problem != null,
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(
                enabled = entered.isNotBlank() && !busy,
                onClick = {
                    busy = true
                    scope.launch {
                        try {
                            setKey(provider.id, entered.trim())
                            entered = ""
                            problem = null
                        } catch (error: Exception) {
                            problem = explain(error)
                        } finally {
                            busy = false
                        }
                    }
                },
            ) { Text(stringResource(if (busy) R.string.servers_trying else R.string.servers_model_save_key)) }
        }
    }
}

/** A button showing the choice, opening a menu of the options (id to name). */
@Composable
private fun Menu(label: String, options: List<Pair<String, String>>, modifier: Modifier, pick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        OutlinedButton(enabled = options.isNotEmpty(), onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
            Text(label, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Icons.Outlined.ArrowDropDown, null)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (id, name) ->
                DropdownMenuItem(text = { Text(name) }, onClick = {
                    open = false
                    pick(id)
                })
            }
        }
    }
}
