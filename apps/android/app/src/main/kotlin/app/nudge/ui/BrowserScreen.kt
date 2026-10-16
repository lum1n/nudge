package app.nudge.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import nudge.client.BrowserFrame
import nudge.client.BrowserState
import nudge.client.ObservedBrowser
import nudge.client.observeBrowser
import nudge.ffi.NudgeClient
import nudge.ffi.PanelStatus

/**
 * The room's own browser, live: log in to a site here when the assistant asks. Taps, scrolls and
 * typing go to that browser only; the assistant never sees passwords.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun BrowserScreen(client: NudgeClient, roomId: String, close: () -> Unit) {
    val observed = remember(client, roomId) { MutableStateFlow<ObservedBrowser?>(null) }
    DisposableEffect(client, roomId) {
        val browser = client.observeBrowser(roomId)
        observed.value = browser
        onDispose { browser.close() }
    }
    val browser by observed.collectAsStateWithLifecycle()
    val state = browser?.state?.collectAsStateWithLifecycle()?.value ?: BrowserState()

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text("Browser") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, "Close") } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            val status = state.status
            val live = browser
            when {
                status is PanelStatus.Closed -> Text(
                    if (status.code.toInt() == 4404) {
                        "This room has no browser. Turn on the browser extension for it under About this room."
                    } else {
                        "Disconnected${status.reason.takeIf { it.isNotEmpty() }?.let { ": $it" } ?: ""}."
                    },
                    Modifier.align(Alignment.Center).padding(32.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                live == null || status is PanelStatus.Connecting -> Column(
                    Modifier.align(Alignment.Center),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    LoadingIndicator()
                    Text("Starting the browser…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                else -> Live(state, live)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Live(state: BrowserState, browser: ObservedBrowser) {
    val inControl = state.control?.you ?: false
    var address by remember { mutableStateOf("") }
    var keepLogins by remember { mutableStateOf(true) }
    var typed by remember { mutableStateOf("") }
    val frame = state.frame
    LaunchedEffect(frame?.url) { frame?.url?.let { address = it } }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "This is the room's own browser. Log in to a site here when the assistant asks you to. What you type " +
                "goes to this browser only; the assistant never sees passwords.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.control?.takeIf { !it.you }?.let { control ->
            Surface(color = MaterialTheme.colorScheme.tertiaryContainer, shape = MaterialTheme.shapes.large) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${control.holder ?: "Someone else"} is using the browser; you are watching.",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    TextButton(onClick = browser::takeControl, shapes = ButtonDefaults.shapes()) { Text("Take control") }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = browser::back, enabled = inControl) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            OutlinedTextField(
                value = address,
                onValueChange = { address = it },
                singleLine = true,
                enabled = inControl,
                shape = MaterialTheme.shapes.large,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { if (address.isNotBlank()) browser.navigate(address.trim()) }),
                modifier = Modifier.weight(1f),
            )
        }
        // A tap may focus another field, where typing starts over.
        Page(frame, inControl, browser, tapped = { typed = "" })
        Typing(typed, { typed = it }, inControl, browser)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Remember logins I type here, so the assistant can log in by itself next time",
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
            )
            Switch(checked = keepLogins, onCheckedChange = { keepLogins = it })
        }
        Button(
            onClick = { browser.done(keepLogins) },
            enabled = inControl,
            shapes = ButtonDefaults.shapes(),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Done") }
        state.saved?.let { saved ->
            Text(
                (if (saved.isEmpty()) "Nothing to save." else "Saved the login for ${saved.joinToString()}.") +
                    " Ask the assistant to try again.",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        SavedLogins(state, browser)
    }
}

/** The page, about as wide as the screen: a tap clicks there, a drag scrolls. */
@Composable
private fun Page(frame: BrowserFrame?, inControl: Boolean, browser: ObservedBrowser, tapped: () -> Unit) {
    if (frame == null || frame.width == 0 || frame.height == 0) {
        Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) {
            Text("Waiting for the page…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    // Decoded off the main thread; the last one stays on screen until the next is ready.
    val image by produceState<ImageBitmap?>(null, frame) {
        value = withContext(Dispatchers.Default) {
            BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size)?.asImageBitmap()
        } ?: value
    }
    val current by rememberUpdatedState(frame)
    val driving by rememberUpdatedState(inControl)
    var size by remember { mutableStateOf(IntSize.Zero) }
    fun toPage(at: Offset): Pair<Int, Int> {
        val page = current
        if (size.width == 0 || size.height == 0) return 0 to 0
        return (at.x / size.width * page.width).toInt() to (at.y / size.height * page.height).toInt()
    }
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(frame.width.toFloat() / frame.height)
            .clip(MaterialTheme.shapes.medium)
            .onSizeChanged { size = it }
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { at ->
                        if (!driving) return@detectTapGestures
                        val (x, y) = toPage(at)
                        browser.click(x, y)
                        tapped()
                    },
                    onLongPress = { at ->
                        if (!driving) return@detectTapGestures
                        val (x, y) = toPage(at)
                        browser.click(x, y, button = "right")
                    },
                )
            }
            .pointerInput(Unit) {
                detectDragGestures { change, drag ->
                    change.consume()
                    if (!driving) return@detectDragGestures
                    val (x, y) = toPage(change.position)
                    val scale = current.width.toFloat() / this.size.width
                    browser.scroll(x, y, (-drag.x * scale).toDouble(), (-drag.y * scale).toDouble())
                }
            },
    ) {
        image?.let {
            Image(
                it,
                contentDescription = "The room's browser, at ${frame.url}",
                contentScale = ContentScale.FillBounds,
                modifier = Modifier.fillMaxSize(),
                alpha = if (inControl) 1f else 0.85f,
            )
        }
    }
}

/**
 * What is typed here goes to the page as it is typed: added letters as text, removed ones as
 * Backspace. It is hidden like a password, since the page shows what a field may show.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Typing(typed: String, onTyped: (String) -> Unit, inControl: Boolean, browser: ObservedBrowser) {
    OutlinedTextField(
        value = typed,
        onValueChange = { next ->
            val common = typed.commonPrefixWith(next).length
            repeat(typed.length - common) { browser.press("Backspace") }
            if (next.length > common) browser.type(next.substring(common))
            onTyped(next)
        },
        enabled = inControl,
        label = { Text("Type into the page") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = {
            browser.press("Enter")
            onTyped("")
        }),
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth(),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AssistChip(onClick = { browser.press("Tab"); onTyped("") }, enabled = inControl, label = { Text("Tab") })
        AssistChip(onClick = { browser.press("Enter"); onTyped("") }, enabled = inControl, label = { Text("Enter") })
        AssistChip(onClick = { browser.press("Backspace") }, enabled = inControl, label = { Text("Backspace") })
        AssistChip(onClick = { browser.press("Escape") }, enabled = inControl, label = { Text("Esc") })
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun SavedLogins(state: BrowserState, browser: ObservedBrowser) {
    val logins = state.logins.orEmpty()
    Column(Modifier.padding(bottom = 24.dp)) {
        Section("Saved logins")
        if (logins.isEmpty()) {
            Text(
                "None yet. Logins you remember here show up here.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(ListItemDefaults.SegmentedGap)) {
            logins.forEachIndexed { index, login ->
                SegmentedListItem(
                    shapes = ListItemDefaults.segmentedShapes(index = index, count = logins.size),
                    leadingContent = { Icon(Icons.Outlined.Key, null) },
                    supportingContent = {
                        Text(
                            listOfNotNull(
                                login.username,
                                "saved ${DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(login.savedAt.toLong()))}",
                            ).joinToString(" · "),
                        )
                    },
                    trailingContent = {
                        FilledTonalButton(onClick = { browser.forget(login) }, shapes = ButtonDefaults.shapes()) { Text("Forget") }
                    },
                ) { Text(login.host) }
            }
        }
    }
}
