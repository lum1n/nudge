package app.nudge.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import app.nudge.Session
import app.nudge.avatar.Accessory
import app.nudge.avatar.Avatar
import app.nudge.avatar.EyeShape
import app.nudge.avatar.Mood
import app.nudge.avatar.PRESETS
import app.nudge.avatar.Portrait
import app.nudge.avatar.RobotLook
import app.nudge.avatar.argb
import app.nudge.avatar.look
import app.nudge.avatar.toAppearance
import app.nudge.explain
import androidx.compose.runtime.collectAsState
import kotlinx.coroutines.launch

/** Colours to pick from in one tap; any other goes in as `#rrggbb`. */
private val SWATCHES = listOf(
    "#1438f5", "#19e6f0", "#3ff6ff", "#2fe6b8", "#127a4a", "#a5e86a", "#e4f36a", "#ffd36b",
    "#ffb238", "#ff7a45", "#e8361c", "#ff6fcf", "#e45bff", "#5b21d6", "#30343c", "#8a94a6", "#ffffff",
)

private val HEX = Regex("^#[0-9a-fA-F]{6}$")

/**
 * How the assistant's robot looks to everyone who uses it, in every app, set by an admin. Room
 * lists show a change at once.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun RobotScreen(session: Session, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val saved = session.look()
    val chosen = session.roomList.state.collectAsState().value?.view?.appearance != null
    var draft by remember { mutableStateOf<RobotLook?>(null) }
    var saving by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val look = draft ?: saved
    val dirty = draft != null && draft != saved

    fun save(next: RobotLook?) {
        saving = true
        problem = null
        scope.launch {
            try {
                session.client.setAppearance(next?.toAppearance())
                draft = null
            } catch (error: Exception) {
                problem = explain(error)
            } finally {
                saving = false
            }
        }
    }

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text("Robot") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
        bottomBar = {
            if (dirty || problem != null) {
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                    Row(
                        Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            problem ?: "Unsaved changes",
                            Modifier.weight(1f),
                            color = if (problem != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                        )
                        if (dirty) {
                            OutlinedButton(onClick = { draft = null }, enabled = !saving, shapes = ButtonDefaults.shapes()) {
                                Text("Discard")
                            }
                            Button(onClick = { save(look) }, enabled = !saving, shapes = ButtonDefaults.shapes()) {
                                Text(if (saving) "Saving…" else "Save")
                            }
                        }
                    }
                }
            }
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).imePadding(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Avatar(Mood.IDLE, appearance = look, size = 160.dp)
                    Text(
                        "How the assistant looks to everyone who uses it, in every app.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            item { Section("Start from") }
            item {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    PRESETS.forEach { (name, preset) ->
                        Column(
                            Modifier.clickable { draft = preset }.padding(4.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Portrait(appearance = preset, size = 52.dp)
                            Text(name, style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
            }
            item { Section("Colours") }
            item { ColourRow("Ribbon", look.body.first) { draft = look.copy(body = it to look.body.second) } }
            item { ColourRow("Ribbon end", look.body.second) { draft = look.copy(body = look.body.first to it) } }
            item { ColourRow("Eyes", look.eyes) { draft = look.copy(eyes = it) } }
            item { ColourRow("Sparks", look.sparks) { draft = look.copy(sparks = it) } }
            item { Section("Eyes") }
            item {
                Choices(EyeShape.entries, look.eyeShape) { draft = look.copy(eyeShape = it) }
            }
            item { Section("Wears") }
            item {
                Choices(Accessory.entries, look.accessory) { draft = look.copy(accessory = it) }
            }
            if (chosen && !dirty) {
                item {
                    TextButton(onClick = { save(null) }, enabled = !saving) { Text("Back to the app icon's") }
                }
            }
        }
    }
}

@Composable
private fun <T : Enum<T>> Choices(options: List<T>, chosen: T, pick: (T) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { option ->
            FilterChip(
                selected = option == chosen,
                onClick = { pick(option) },
                label = { Text(option.name.lowercase().replaceFirstChar { it.uppercase() }) },
            )
        }
    }
}

/** A colour: a row of swatches, and the code for any other. */
@Composable
private fun ColourRow(label: String, hex: String, pick: (String) -> Unit) {
    var typed by remember(hex) { mutableStateOf(hex) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
            OutlinedTextField(
                value = typed,
                onValueChange = { value ->
                    typed = value
                    if (HEX.matches(value)) pick(value.lowercase())
                },
                singleLine = true,
                isError = !HEX.matches(typed),
                textStyle = TextStyle(fontFamily = FontFamily.Monospace),
                modifier = Modifier.width(130.dp),
            )
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SWATCHES.forEach { swatch ->
                val picked = swatch.equals(hex, ignoreCase = true)
                Surface(
                    modifier = Modifier
                        .size(32.dp)
                        .border(if (picked) 3.dp else 1.dp, if (picked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, CircleShape)
                        .clickable { pick(swatch) },
                    shape = CircleShape,
                    color = Color(argb(swatch)),
                ) {}
            }
        }
    }
}
