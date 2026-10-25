package app.nudge.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.R
import kotlin.math.abs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import nudge.client.DesktopState
import nudge.client.ObservedDesktop
import nudge.client.observeDesktop
import nudge.ffi.NudgeClient
import nudge.ffi.PanelStatus

/** How far a finger moves on the desktop's screen, in its pixels, for one notch of scrolling. */
private const val NOTCH_PIXELS = 60f

/**
 * The room's desktop, live: watch the assistant use its apps, or take over. Taps, drags and
 * typing go to that desktop only.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun DesktopScreen(client: NudgeClient, roomId: String, close: () -> Unit) {
    val observed = remember(client, roomId) { MutableStateFlow<ObservedDesktop?>(null) }
    DisposableEffect(client, roomId) {
        val desktop = client.observeDesktop(roomId)
        observed.value = desktop
        onDispose { desktop.close() }
    }
    val desktop by observed.collectAsStateWithLifecycle()
    val state = desktop?.state?.collectAsStateWithLifecycle()?.value ?: DesktopState()

    // The screen as drawn so far, each patch over the last; `drawn` counts them, to redraw.
    var screen by remember(desktop) { mutableStateOf<Bitmap?>(null) }
    var drawn by remember(desktop) { mutableIntStateOf(0) }
    LaunchedEffect(desktop) {
        val live = desktop ?: return@LaunchedEffect
        for (patch in live.patches) {
            val image = withContext(Dispatchers.Default) {
                BitmapFactory.decodeByteArray(patch.png, 0, patch.png.size)
            } ?: continue
            val current = screen?.takeIf { it.width == patch.screenWidth && it.height == patch.screenHeight }
                ?: Bitmap.createBitmap(patch.screenWidth, patch.screenHeight, Bitmap.Config.ARGB_8888).also { screen = it }
            android.graphics.Canvas(current).drawBitmap(image, patch.x.toFloat(), patch.y.toFloat(), null)
            image.recycle()
            drawn++
        }
    }

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(stringResource(R.string.panels_desktop)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, stringResource(R.string.panels_close)) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            val status = state.status
            val live = desktop
            when {
                status is PanelStatus.Closed -> Text(
                    if (status.code.toInt() == 4404) {
                        stringResource(R.string.panels_desktop_off)
                    } else {
                        status.reason.takeIf { it.isNotEmpty() }?.let { stringResource(R.string.panels_disconnected_because, it) }
                            ?: stringResource(R.string.panels_disconnected)
                    },
                    Modifier.align(Alignment.Center).padding(32.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                live == null || status is PanelStatus.Connecting -> Column(
                    Modifier.align(Alignment.Center),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    LoadingIndicator()
                    Text(stringResource(R.string.panels_desktop_starting), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                else -> Live(state, live, screen, drawn)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Live(state: DesktopState, desktop: ObservedDesktop, screen: Bitmap?, drawn: Int) {
    val inControl = state.control?.you ?: false
    // Read as it is now in each change: several can come before the next recomposition.
    val typed = remember { mutableStateOf("") }
    var selecting by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            stringResource(R.string.panels_desktop_intro),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.control?.takeIf { !it.you }?.let { control ->
            Surface(color = MaterialTheme.colorScheme.tertiaryContainer, shape = MaterialTheme.shapes.large) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        stringResource(R.string.panels_desktop_watching, control.holder ?: stringResource(R.string.panels_someone_else)),
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    TextButton(onClick = desktop::takeControl, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.panels_take_control)) }
                }
            }
        }
        if (state.apps.isNotEmpty() || state.windows.isNotEmpty()) {
            // No window manager: windows come to the front from here, and apps start from here.
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                state.apps.forEach { app ->
                    AssistChip(onClick = { desktop.launch(app) }, enabled = inControl, label = { Text(stringResource(R.string.panels_desktop_start_app, app)) })
                }
                state.windows.forEach { window ->
                    AssistChip(
                        onClick = { desktop.raise(window); typed.value = "" },
                        enabled = inControl,
                        label = { Text(window.title.ifEmpty { window.app }, maxLines = 1) },
                    )
                }
            }
        }
        // A tap may focus another field, where typing starts over.
        Screen(state, screen, drawn, inControl, selecting, desktop, tapped = { typed.value = "" })
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(if (selecting) R.string.panels_desktop_drag_selects else R.string.panels_desktop_drag_scrolls),
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FilterChip(selected = selecting, onClick = { selecting = !selecting }, label = { Text(stringResource(R.string.panels_desktop_drag_to_select)) })
        }
        state.working?.let {
            Text(stringResource(R.string.panels_desktop_working, it), style = MaterialTheme.typography.bodyMedium)
        }
        Typing(typed, inControl, desktop)
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

/**
 * The desktop's screen, as wide as the page: a tap clicks there, a double tap double-clicks, a
 * long press right-clicks, and a drag scrolls or, while selecting, drags.
 */
@Composable
private fun Screen(
    state: DesktopState,
    screen: Bitmap?,
    drawn: Int,
    inControl: Boolean,
    selecting: Boolean,
    desktop: ObservedDesktop,
    tapped: () -> Unit,
) {
    if (screen == null || state.screenWidth == 0 || state.screenHeight == 0) {
        Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.panels_desktop_waiting), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    val image = remember(screen) { screen.asImageBitmap() }
    val description = stringResource(R.string.panels_desktop_screen)
    val driving by rememberUpdatedState(inControl)
    val dragging by rememberUpdatedState(selecting)
    val pixels by rememberUpdatedState(IntSize(screen.width, screen.height))
    var size by remember { mutableStateOf(IntSize.Zero) }
    fun toScreen(at: Offset): Pair<Int, Int> {
        if (size.width == 0 || size.height == 0) return 0 to 0
        return (at.x / size.width * pixels.width).toInt() to (at.y / size.height * pixels.height).toInt()
    }
    Canvas(
        Modifier
            .fillMaxWidth()
            .aspectRatio(screen.width.toFloat() / screen.height)
            .clip(MaterialTheme.shapes.medium)
            .alpha(if (inControl) 1f else 0.85f)
            .semantics { contentDescription = description }
            .onSizeChanged { size = it }
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { at ->
                        if (!driving) return@detectTapGestures
                        val (x, y) = toScreen(at)
                        desktop.click(x, y)
                        tapped()
                    },
                    onDoubleTap = { at ->
                        if (!driving) return@detectTapGestures
                        val (x, y) = toScreen(at)
                        desktop.click(x, y, double = true)
                    },
                    onLongPress = { at ->
                        if (!driving) return@detectTapGestures
                        val (x, y) = toScreen(at)
                        desktop.click(x, y, button = "right")
                    },
                )
            }
            .pointerInput(Unit) {
                var from = Offset.Zero
                var at = Offset.Zero
                var scrolled = 0f
                detectDragGestures(
                    onDragStart = { start ->
                        from = start
                        at = start
                        scrolled = 0f
                    },
                    onDragEnd = {
                        if (!driving || !dragging) return@detectDragGestures
                        val (fromX, fromY) = toScreen(from)
                        val (toX, toY) = toScreen(at)
                        desktop.drag(fromX, fromY, toX, toY)
                    },
                ) { change, drag ->
                    change.consume()
                    at = change.position
                    if (!driving || dragging) return@detectDragGestures
                    // Whole notches, as a mouse wheel turns: the content follows the finger.
                    scrolled -= drag.y * pixels.height / size.height.coerceAtLeast(1)
                    if (abs(scrolled) < NOTCH_PIXELS) return@detectDragGestures
                    val (x, y) = toScreen(at)
                    desktop.scroll(x, y, 0.0, if (scrolled > 0) 100.0 else -100.0)
                    scrolled -= if (scrolled > 0) NOTCH_PIXELS else -NOTCH_PIXELS
                }
            },
    ) {
        // Read here so each patch drawn into the bitmap redraws it.
        drawn
        drawImage(
            image,
            dstSize = IntSize(this.size.width.toInt(), this.size.height.toInt()),
            filterQuality = FilterQuality.Medium,
        )
    }
}

/**
 * What is typed here goes to the desktop as it is typed: added letters as text, removed ones as
 * Backspace, into the window under the pointer (the one last tapped).
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Typing(typed: MutableState<String>, inControl: Boolean, desktop: ObservedDesktop) {
    OutlinedTextField(
        value = typed.value,
        onValueChange = { next ->
            val before = typed.value
            val common = before.commonPrefixWith(next).length
            repeat(before.length - common) { desktop.press("Backspace") }
            if (next.length > common) desktop.type(next.substring(common))
            typed.value = next
        },
        enabled = inControl,
        label = { Text(stringResource(R.string.panels_desktop_type)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, autoCorrectEnabled = false, imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = {
            desktop.press("Enter")
            typed.value = ""
        }),
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth(),
    )
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AssistChip(onClick = { desktop.press("Tab"); typed.value = "" }, enabled = inControl, label = { Text("Tab") })
        AssistChip(onClick = { desktop.press("Enter"); typed.value = "" }, enabled = inControl, label = { Text("Enter") })
        AssistChip(onClick = { desktop.press("Backspace") }, enabled = inControl, label = { Text("Backspace") })
        AssistChip(onClick = { desktop.press("Escape"); typed.value = "" }, enabled = inControl, label = { Text("Esc") })
        AssistChip(onClick = { desktop.press("ctrl+s") }, enabled = inControl, label = { Text("Ctrl+S") })
        AssistChip(onClick = { desktop.press("ctrl+z") }, enabled = inControl, label = { Text("Ctrl+Z") })
    }
}
