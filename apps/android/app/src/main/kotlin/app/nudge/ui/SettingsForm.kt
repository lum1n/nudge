// An extension's settings, drawn natively from its JSON Schema (as `nudge.client` reads it): a
// control per field, nested objects and lists of them as groups.
package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import app.nudge.R
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import nudge.client.SettingField
import nudge.client.SettingKind
import nudge.ffi.Room

/** The assistant's rooms, for settings that pick some of them; empty until loaded. */
val LocalRooms = staticCompositionLocalOf<List<Room>> { emptyList() }

/** Controls for `fields`; a field set to null is left out of the object. */
@Composable
fun SettingFields(fields: List<SettingField>, value: JsonObject, onChange: (JsonObject) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        fields.forEach { field ->
            SettingControl(field, value[field.name]) { next ->
                onChange(JsonObject(if (next == null) value - field.name else value + (field.name to next)))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun SettingControl(field: SettingField, value: JsonElement?, onChange: (JsonElement?) -> Unit) {
    val label = field.label + if (field.required && field.default == null) " *" else ""
    when (val kind = field.kind) {
        SettingKind.Toggle -> Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                val on = ((value ?: field.default) as? JsonPrimitive)?.booleanOrNull ?: false
                Switch(checked = on, onCheckedChange = { onChange(JsonPrimitive(it)) })
            }
            Help(field)
        }
        is SettingKind.Text -> Column {
            var shown by remember { mutableStateOf(false) }
            OutlinedTextField(
                value = (value as? JsonPrimitive)?.contentOrNull ?: "",
                onValueChange = { onChange(if (it.isEmpty()) null else JsonPrimitive(it)) },
                label = { Text(label) },
                placeholder = field.default?.let { { Text(shown(it)) } },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                visualTransformation = if (kind.secret && !shown) PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(
                    keyboardType = if (kind.secret) KeyboardType.Password else KeyboardType.Text,
                    autoCorrectEnabled = false,
                ),
                trailingIcon = if (kind.secret) {
                    {
                        IconButton(onClick = { shown = !shown }) {
                            Icon(
                                if (shown) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                stringResource(if (shown) R.string.settings_form_hide else R.string.settings_form_show),
                            )
                        }
                    }
                } else {
                    null
                },
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.fillMaxWidth(),
            )
            Help(field, secret = kind.secret)
        }
        is SettingKind.Number -> Column {
            // Text while typing, so "1." or "-" can be on the way to a number.
            var text by remember { mutableStateOf(value?.let(::shown) ?: "") }
            LaunchedEffect(value) {
                if (number(text, kind.integer) != value) text = value?.let(::shown) ?: ""
            }
            OutlinedTextField(
                value = text,
                onValueChange = {
                    text = it
                    if (it.isBlank()) onChange(null) else number(it, kind.integer)?.let(onChange)
                },
                label = { Text(label) },
                placeholder = field.default?.let { { Text(shown(it)) } },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = if (kind.integer) KeyboardType.Number else KeyboardType.Decimal),
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.fillMaxWidth(),
            )
            Help(field, range = listOfNotNull(
                kind.minimum?.let { stringResource(R.string.settings_form_at_least, shown(JsonPrimitive(it))) },
                kind.maximum?.let { stringResource(R.string.settings_form_at_most, shown(JsonPrimitive(it))) },
            ).joinToString(", ").takeIf { it.isNotEmpty() })
        }
        is SettingKind.Choice -> Column {
            var open by remember { mutableStateOf(false) }
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Box {
                OutlinedButton(onClick = { open = true }, shapes = ButtonDefaults.shapes()) {
                    Text(value?.let(::shown) ?: field.default?.let { stringResource(R.string.settings_form_default_choice, shown(it)) } ?: "—")
                    Icon(Icons.Outlined.ArrowDropDown, null)
                }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    if (!field.required || field.default != null) {
                        DropdownMenuItem(
                            text = { Text(field.default?.let { stringResource(R.string.settings_form_default_choice, shown(it)) } ?: "—") },
                            onClick = {
                                open = false
                                onChange(null)
                            },
                        )
                    }
                    kind.options.forEach { option ->
                        DropdownMenuItem(text = { Text(shown(option)) }, onClick = {
                            open = false
                            onChange(option)
                        })
                    }
                }
            }
            Help(field)
        }
        SettingKind.Lines -> Column {
            var text by remember { mutableStateOf(lines(value).joinToString("\n")) }
            LaunchedEffect(value) {
                if (split(text) != lines(value)) text = lines(value).joinToString("\n")
            }
            OutlinedTextField(
                value = text,
                onValueChange = {
                    text = it
                    val next = split(it)
                    onChange(if (next.isEmpty()) null else JsonArray(next.map(::JsonPrimitive)))
                },
                label = { Text(label) },
                placeholder = { Text(stringResource(R.string.settings_form_one_per_line)) },
                minLines = 2,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.fillMaxWidth(),
            )
            Help(field)
        }
        // Rooms by name, with every room as one choice; ids it no longer knows stay, by id.
        SettingKind.Rooms -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val rooms = LocalRooms.current
            val chosen = lines(value)
            val every = "*" in chosen
            fun set(next: List<String>) = onChange(if (next.isEmpty()) null else JsonArray(next.map(::JsonPrimitive)))
            Text(label, style = MaterialTheme.typography.titleSmall)
            Help(field)
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow) {
                Column(Modifier.padding(vertical = 4.dp)) {
                    CheckRow(stringResource(R.string.settings_form_every_room), every) { on -> set(if (on) listOf("*") else emptyList()) }
                    if (!every) {
                        val unknown = chosen.filter { id -> rooms.none { it.id == id } }
                        (rooms.map { it.id to it.name } + unknown.map { it to it }).forEach { (id, name) ->
                            CheckRow(name, id in chosen) { on -> set(if (on) chosen + id else chosen - id) }
                        }
                    }
                }
            }
        }
        is SettingKind.Group -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, style = MaterialTheme.typography.titleSmall)
            Help(field)
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow) {
                Box(Modifier.padding(12.dp)) {
                    SettingFields(kind.fields, value as? JsonObject ?: JsonObject(emptyMap())) { next ->
                        onChange(if (next.isEmpty()) null else next)
                    }
                }
            }
        }
        is SettingKind.Items -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val items = (value as? JsonArray)?.map { it as? JsonObject ?: JsonObject(emptyMap()) }.orEmpty()
            fun set(next: List<JsonObject>) = onChange(if (next.isEmpty() && !field.required) null else JsonArray(next))
            Text(label, style = MaterialTheme.typography.titleSmall)
            Help(field)
            items.forEachIndexed { index, item ->
                Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "${field.label.removeSuffix("s")} ${index + 1}",
                                Modifier.weight(1f),
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            TextButton(onClick = { set(items.filterIndexed { at, _ -> at != index }) }) { Text(stringResource(R.string.settings_form_remove)) }
                        }
                        SettingFields(kind.fields, item) { next -> set(items.mapIndexed { at, other -> if (at == index) next else other }) }
                    }
                }
            }
            OutlinedButton(onClick = { set(items + JsonObject(emptyMap())) }, shapes = ButtonDefaults.shapes()) {
                Icon(Icons.Outlined.Add, null, Modifier.padding(end = 8.dp))
                Text(stringResource(R.string.settings_form_add))
            }
        }
        SettingKind.Json -> Column {
            // Kept as text until it parses.
            var text by remember { mutableStateOf(value?.toString() ?: "") }
            var wrong by remember { mutableStateOf(false) }
            OutlinedTextField(
                value = text,
                onValueChange = {
                    text = it
                    if (it.isBlank()) {
                        wrong = false
                        onChange(null)
                    } else {
                        val parsed = runCatching { Json.parseToJsonElement(it) }.getOrNull()
                        wrong = parsed == null
                        parsed?.let(onChange)
                    }
                },
                label = { Text(label) },
                isError = wrong,
                supportingText = if (wrong) ({ Text(stringResource(R.string.settings_form_not_json)) }) else null,
                minLines = 3,
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.fillMaxWidth(),
            )
            Help(field)
        }
    }
}

@Composable
private fun Help(field: SettingField, secret: Boolean = false, range: String? = null) {
    // A field's placeholder shows only while it is being typed in.
    val default = field.default?.takeIf { field.kind is SettingKind.Text || field.kind is SettingKind.Number }
    val text = listOfNotNull(
        field.description,
        range?.let { "($it)" },
        default?.let { stringResource(R.string.settings_form_default, shown(it)) },
        if (secret && field.description?.contains("\${") != true) stringResource(R.string.settings_form_secret_help) else null,
    ).joinToString(" ")
    if (text.isEmpty()) return
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 4.dp, top = 4.dp),
    )
}

/** A value as the form shows it: strings without quotes, whole numbers without a point. */
private fun shown(value: JsonElement): String {
    val primitive = value as? JsonPrimitive ?: return value.toString()
    if (primitive.isString) return primitive.content
    val number = primitive.content.toDoubleOrNull()
    return if (number != null && number % 1.0 == 0.0 && !primitive.content.contains('e')) number.toLong().toString() else primitive.content
}

private fun number(text: String, integer: Boolean): JsonPrimitive? {
    val parsed = text.trim().toDoubleOrNull()?.takeIf { it.isFinite() } ?: return null
    if (integer && parsed % 1.0 != 0.0) return null
    return if (parsed % 1.0 == 0.0) JsonPrimitive(parsed.toLong()) else JsonPrimitive(parsed)
}

private fun lines(value: JsonElement?): List<String> =
    (value as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

private fun split(text: String): List<String> = text.lines().map { it.trim() }.filter { it.isNotEmpty() }

@Composable
private fun CheckRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(value = checked, role = Role.Checkbox, onValueChange = onChange)
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Checkbox(checked = checked, onCheckedChange = null)
        Text(label)
    }
}
