package app.nudge.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import android.content.Intent
import android.net.Uri
import android.text.format.DateFormat
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.runtime.produceState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import java.text.NumberFormat
import kotlin.math.roundToInt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.ui.platform.LocalContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import app.nudge.R
import kotlinx.coroutines.launch
import nudge.client.MissingField
import nudge.client.UiBlock
import nudge.client.UiButton
import nudge.client.UiCard
import nudge.client.UiField
import nudge.client.UiValue
import nudge.client.card
import nudge.client.pressed
import nudge.ffi.ToolPart

/** Presses a button on a card in the room on screen; null where cards can't be pressed. */
val LocalCardPress = compositionLocalOf<(suspend (callId: String, card: UiCard, button: UiButton, values: Map<String, UiValue>) -> Unit)?> { null }

/**
 * A card a tool showed in the chat (ADR 27): its blocks, fields and buttons. A press posts it,
 * and it comes back in the chat as the reader's message.
 */
@Composable
fun CardView(tool: ToolPart, card: UiCard = tool.card!!) {
    val press = LocalCardPress.current
    val pressed = tool.pressed
    val done = pressed != null && card.once
    val values = remember(tool.callId) { mutableStateMapOf<String, UiValue>() }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val missing = stringResource(R.string.room_card_missing, "%s")

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            card.title?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
            card.blocks.forEach { Block(it) }
            if (!done) card.fields.forEach { field ->
                Field(field, values[field.name], enabled = !busy && press != null) { values[field.name] = it }
            }
            if (card.buttons.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                card.buttons.forEach { button ->
                    if (button.url != null) {
                        LinkButton(button.label, button.url!!)
                        return@forEach
                    }
                    val onClick: () -> Unit = {
                        error = null
                        busy = true
                        scope.launch {
                            try {
                                press?.invoke(tool.callId, card, button, values.toMap())
                                values.clear()
                            } catch (missingField: MissingField) {
                                error = missing.replace("%s", missingField.label)
                            } catch (failed: Exception) {
                                error = failed.message
                            } finally {
                                busy = false
                            }
                        }
                    }
                    val enabled = !busy && !done && press != null
                    if (button.style == null) {
                        OutlinedButton(onClick, enabled = enabled, shapes = ButtonDefaults.shapes()) { Text(button.label) }
                    } else {
                        Button(
                            onClick,
                            enabled = enabled,
                            shapes = ButtonDefaults.shapes(),
                            colors = if (button.style == "danger") {
                                ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                            } else {
                                ButtonDefaults.buttonColors()
                            },
                        ) { Text(button.label) }
                    }
                }
            }
            pressed?.let {
                val label = card.buttons.firstOrNull { button -> button.id == it.button }?.label ?: it.button
                Text(
                    stringResource(R.string.room_card_pressed_by, it.by, label),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable
private fun Block(block: UiBlock) {
    when (block) {
        is UiBlock.Heading -> Text(block.text, fontWeight = FontWeight.SemiBold)
        is UiBlock.Text -> Text(markdown(block.markdown))
        is UiBlock.KeyValues -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            block.pairs.forEach { pair ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(pair.label, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.widthIn(max = 160.dp))
                    Text(pair.value)
                }
            }
        }
        is UiBlock.Items -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            block.items.forEach { item ->
                Column {
                    Text(item.title)
                    item.subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        }
        is UiBlock.Table -> Column(Modifier.horizontalScroll(rememberScrollState())) {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                block.columns.forEach { Text(it, fontWeight = FontWeight.SemiBold, modifier = Modifier.widthIn(min = 64.dp)) }
            }
            HorizontalDivider()
            block.rows.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    block.columns.indices.forEach { Text(row.getOrElse(it) { "" }, modifier = Modifier.widthIn(min = 64.dp)) }
                }
            }
        }
        is UiBlock.Image -> CardImage(block)
        UiBlock.Divider -> HorizontalDivider()
        is UiBlock.Places -> CardMap(block)
        is UiBlock.Chart -> CardChart(block)
        is UiBlock.Stats -> CardStats(block)
        is UiBlock.Progress -> CardProgress(block)
        is UiBlock.Timeline -> CardTimeline(block)
        is UiBlock.Event -> CardEvent(block)
        is UiBlock.Diagram -> CardDiagram(block)
    }
}

@Composable
private fun Field(field: UiField, value: UiValue?, enabled: Boolean, onChange: (UiValue) -> Unit) {
    val label = if (field.optional) stringResource(R.string.room_card_optional, field.label) else field.label
    when (field.type) {
        "boolean" -> Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox((value as? UiValue.Flag)?.on == true, { onChange(UiValue.Flag(it)) }, enabled = enabled)
            Text(label)
        }
        "choice" -> {
            var open by remember { mutableStateOf(false) }
            Column {
                Text(label, style = MaterialTheme.typography.labelMedium)
                OutlinedButton({ open = true }, enabled = enabled) {
                    Text((value as? UiValue.Text)?.text ?: stringResource(R.string.room_card_choose))
                }
                DropdownMenu(open, { open = false }) {
                    field.options.forEach { option ->
                        DropdownMenuItem({ Text(option) }, {
                            onChange(UiValue.Text(option))
                            open = false
                        })
                    }
                }
            }
        }
        "choices" -> Column {
            Text(label, style = MaterialTheme.typography.labelMedium)
            val picked = (value as? UiValue.Choices)?.picked.orEmpty()
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                field.options.forEach { option ->
                    FilterChip(
                        selected = option in picked,
                        onClick = {
                            val next = if (option in picked) picked - option else field.options.filter { it == option || it in picked }
                            onChange(UiValue.Choices(next))
                        },
                        label = { Text(option) },
                        enabled = enabled,
                    )
                }
            }
        }
        "range" -> {
            val min = (field.min ?: 0.0).toFloat()
            val max = (field.max ?: 100.0).toFloat()
            val step = (field.step ?: 1.0).toFloat()
            val current = ((value as? UiValue.Number)?.number ?: min.toDouble()).toFloat()
            Column {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(label, style = MaterialTheme.typography.labelMedium)
                    Text(NumberFormat.getNumberInstance().format(current), style = MaterialTheme.typography.labelMedium)
                }
                Slider(
                    value = current,
                    onValueChange = { onChange(UiValue.Number((min + ((it - min) / step).roundToInt() * step).toDouble())) },
                    valueRange = min..max,
                    steps = (((max - min) / step).roundToInt() - 1).coerceIn(0, 200),
                    enabled = enabled,
                )
            }
        }
        "date", "time" -> WhenField(field, label, (value as? UiValue.Text)?.text, enabled) { onChange(UiValue.Text(it)) }
        else -> {
            // A number field keeps what is typed; text that isn't a number counts as empty.
            var text by remember { mutableStateOf((value as? UiValue.Text)?.text ?: "") }
            OutlinedTextField(
                value = if (value == null) "" else text,
                onValueChange = {
                    text = it
                    if (field.type == "number") {
                        it.toDoubleOrNull()?.let { number -> onChange(UiValue.Number(number)) } ?: onChange(UiValue.Text(""))
                    } else {
                        onChange(UiValue.Text(it))
                    }
                },
                label = { Text(label) },
                placeholder = field.placeholder?.let { { Text(it) } },
                singleLine = !field.multiline,
                minLines = if (field.multiline) 3 else 1,
                enabled = enabled,
                keyboardOptions = if (field.type == "number") KeyboardOptions(keyboardType = KeyboardType.Decimal) else KeyboardOptions.Default,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** A day or a time of day, picked in a dialog and sent as `YYYY-MM-DD` or `HH:MM`. */
@Composable
private fun WhenField(field: UiField, label: String, value: String?, enabled: Boolean, onChange: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium)
        OutlinedButton({ open = true }, enabled = enabled) { Text(value ?: field.placeholder ?: stringResource(R.string.room_card_choose)) }
    }
    if (!open) return
    if (field.type == "date") {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = value?.let { runCatching { LocalDate.parse(it).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() }.getOrNull() },
        )
        DatePickerDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton({
                    state.selectedDateMillis?.let { onChange(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString()) }
                    open = false
                }) { Text(stringResource(android.R.string.ok)) }
            },
            dismissButton = { TextButton({ open = false }) { Text(stringResource(android.R.string.cancel)) } },
        ) { DatePicker(state) }
    } else {
        val (hour, minute) = value?.split(":")?.mapNotNull { it.toIntOrNull() }?.takeIf { it.size == 2 } ?: listOf(12, 0)
        val state = rememberTimePickerState(hour, minute, is24Hour = DateFormat.is24HourFormat(LocalContext.current))
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton({
                    onChange("%02d:%02d".format(state.hour, state.minute))
                    open = false
                }) { Text(stringResource(android.R.string.ok)) }
            },
            dismissButton = { TextButton({ open = false }) { Text(stringResource(android.R.string.cancel)) } },
            text = { TimePicker(state) },
        )
    }
}

/** A button that opens its page once the reader says yes to the site (ADR 30); nothing reaches the room. */
@Composable
private fun LinkButton(label: String, url: String) {
    val context = LocalContext.current
    var asking by remember { mutableStateOf(false) }
    OutlinedButton({ asking = true }, shapes = ButtonDefaults.shapes()) {
        Text(label)
        Icon(Icons.AutoMirrored.Filled.OpenInNew, null, Modifier.padding(start = 4.dp).size(16.dp))
    }
    if (!asking) return
    val host = Uri.parse(url).host ?: url
    AlertDialog(
        onDismissRequest = { asking = false },
        title = { Text(stringResource(R.string.room_card_open_link, host)) },
        text = { Text(url, style = MaterialTheme.typography.bodySmall) },
        confirmButton = {
            TextButton({
                asking = false
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            }) { Text(stringResource(R.string.room_card_open)) }
        },
        dismissButton = { TextButton({ asking = false }) { Text(stringResource(android.R.string.cancel)) } },
    )
}

/** An image attachment, from the room's attachments; its words until it is there, or when it can't be. */
@Composable
private fun CardImage(block: UiBlock.Image) {
    val store = LocalRoomAttachments.current
    val image by produceState<ImageBitmap?>(null, block.attachment, store) {
        value = (runCatching { store?.image(block.attachment) }.getOrNull() as? RoomAttachments.ImageResult.Shown)?.image
    }
    image?.let {
        Image(
            it,
            contentDescription = block.alt,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).clip(MaterialTheme.shapes.medium),
        )
    } ?: Text(block.alt, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
