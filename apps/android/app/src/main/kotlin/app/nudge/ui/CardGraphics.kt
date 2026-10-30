package app.nudge.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.BitmapFactory
import android.icu.text.CompactDecimalFormat
import android.net.Uri
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nudge.BuildConfig
import app.nudge.R
import java.net.HttpURLConnection
import java.net.URL
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sinh
import kotlin.math.tan
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nudge.client.UiBlock

/*
 * The cards' maps, charts, stats, progress bars and timelines (ADR 29), drawn on a Canvas with no
 * library of their own.
 */

/**
 * The series' colours, in this order and never cycled, so each pair next to each other stays
 * apart for colour-blind readers too; a dark surface gets the same hues stepped for it.
 */
private val lightSeries = listOf(0xFF2A78D6, 0xFFEB6834, 0xFF1BAF7A, 0xFFEDA100, 0xFFE87BA4, 0xFF008300, 0xFF6250D6, 0xFFE34948).map(::Color)
private val darkSeries = listOf(0xFF3987E5, 0xFFD95926, 0xFF199E70, 0xFFC98500, 0xFFD55181, 0xFF008300, 0xFF9085E9, 0xFFE66767).map(::Color)

@Composable
private fun seriesColors(): List<Color> = if (MaterialTheme.colorScheme.surface.luminance() < 0.5f) darkSeries else lightSeries

/**
 * Where the map comes from: OpenStreetMap's own tiles. The card gives coordinates only, so what
 * loads is always this, and only the area around them.
 */
private const val TILES = "https://tile.openstreetmap.org"
private const val TILE = 256f

/** Tiles fetched this run, by `zoom/x/y`. */
private val tiles = LruCache<String, ImageBitmap>(48)

private suspend fun tile(key: String): ImageBitmap? = tiles.get(key) ?: withContext(Dispatchers.IO) {
    runCatching {
        val connection = URL("$TILES/$key.png").openConnection() as HttpURLConnection
        // OpenStreetMap asks apps to name themselves.
        connection.setRequestProperty("User-Agent", "Nudge/${BuildConfig.VERSION_NAME} (Android)")
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.inputStream.use { BitmapFactory.decodeStream(it)?.asImageBitmap() }
    }.getOrNull()?.also { tiles.put(key, it) }
}

/** Where a place lies on the world map, from 0 to 1 each way (Web Mercator). */
private fun project(lat: Double, lon: Double): Offset {
    val phi = lat.coerceIn(-85.05, 85.05) * PI / 180
    return Offset(((lon + 180) / 360).toFloat(), ((1 - ln(tan(phi) + 1 / cos(phi)) / PI) / 2).toFloat())
}

/** A card's map: tiles around its markers and path, each marker numbered; a tap opens a map app. */
@Composable
fun CardMap(block: UiBlock.Places) {
    val context = LocalContext.current
    val colors = seriesColors()
    val points = block.markers.map { project(it.lat, it.lon) } + block.path.map { project(it.lat, it.lon) }
    val loaded = remember(block) { mutableStateMapOf<String, ImageBitmap>() }
    val measurer = rememberTextMeasurer()
    val description = block.markers.joinToString { it.label }.ifEmpty { stringResource(R.string.room_card_map) }
    val center = Offset((points.minOf { it.x } + points.maxOf { it.x }) / 2, (points.minOf { it.y } + points.maxOf { it.y }) / 2)
    val open = {
        val lat = atan(sinh(PI * (1 - 2 * center.y))) * 180 / PI
        val lon = center.x * 360.0 - 180
        val only = block.markers.singleOrNull()
        val query = only?.let { "${it.lat},${it.lon}(${Uri.encode(it.label)})" } ?: "$lat,$lon"
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:$lat,$lon?q=$query")))
        } catch (_: ActivityNotFoundException) {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.openstreetmap.org/?mlat=$lat&mlon=$lon")))
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BoxWithConstraints(
            Modifier.fillMaxWidth().height(200.dp).clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                .clickable(onClick = open)
                .semantics { contentDescription = description },
        ) {
            val density = LocalDensity.current
            // Tiles are drawn 256 dp wide, so the zoom fits the box in dp.
            val width = maxWidth.value
            val height = 200f
            val pad = 28f
            var zoom = 15
            while (zoom > 0 && (
                    (points.maxOf { it.x } - points.minOf { it.x }) * TILE * 2f.pow(zoom) > width - 2 * pad ||
                        (points.maxOf { it.y } - points.minOf { it.y }) * TILE * 2f.pow(zoom) > height - 2 * pad
                    )
            ) zoom--
            val scale = TILE * 2f.pow(zoom)
            val left = center.x * scale - width / 2
            val top = center.y * scale - height / 2
            val count = 1 shl zoom
            val needed = buildList {
                for (y in floor(top / TILE).toInt()..floor((top + height) / TILE).toInt()) {
                    if (y !in 0 until count) continue
                    for (x in floor(left / TILE).toInt()..floor((left + width) / TILE).toInt()) add(Triple(x, y, "$zoom/${x.mod(count)}/$y"))
                }
            }
            LaunchedEffect(needed) {
                for ((_, _, key) in needed) if (key !in loaded) launch { tile(key)?.let { loaded[key] = it } }
            }
            val pin = colors[0]
            Canvas(Modifier.fillMaxWidth().height(200.dp)) {
                val dp = density.density
                fun at(lat: Double, lon: Double) = project(lat, lon).let { Offset((it.x * scale - left) * dp, (it.y * scale - top) * dp) }
                for ((x, y, key) in needed) loaded[key]?.let {
                    drawImage(
                        it,
                        dstOffset = IntOffset(((x * TILE - left) * dp).roundToInt(), ((y * TILE - top) * dp).roundToInt()),
                        dstSize = IntSize((TILE * dp).roundToInt() + 1, (TILE * dp).roundToInt() + 1),
                    )
                }
                if (block.path.size > 1) {
                    val path = Path().apply {
                        block.path.forEachIndexed { index, point ->
                            val offset = at(point.lat, point.lon)
                            if (index == 0) moveTo(offset.x, offset.y) else lineTo(offset.x, offset.y)
                        }
                    }
                    // A white edge under the line keeps it clear of the roads beneath.
                    drawPath(path, Color.White, style = Stroke(6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
                    drawPath(path, pin, style = Stroke(3.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
                }
                block.markers.forEachIndexed { index, marker ->
                    val offset = at(marker.lat, marker.lon)
                    drawCircle(Color.White, 12.dp.toPx(), offset)
                    drawCircle(pin, 10.dp.toPx(), offset)
                    val text = measurer.measure("${index + 1}", TextStyle(color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold))
                    drawText(text, topLeft = offset - Offset(text.size.width / 2f, text.size.height / 2f))
                }
            }
            Text(
                "© OpenStreetMap",
                style = MaterialTheme.typography.labelSmall,
                color = Color(0xFF44403C),
                modifier = Modifier.align(Alignment.BottomEnd).background(Color.White.copy(alpha = 0.7f)).padding(horizontal = 4.dp),
            )
        }
        if (block.markers.size == 1) Text(block.markers[0].label)
        if (block.markers.size > 1) block.markers.forEachIndexed { index, marker ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${index + 1}", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(16.dp))
                Text(marker.label)
            }
        }
    }
}

private val compact = CompactDecimalFormat.getInstance(Locale.getDefault(), CompactDecimalFormat.CompactStyle.SHORT).apply { maximumFractionDigits = 1 }
private val full: NumberFormat = NumberFormat.getNumberInstance().apply { maximumFractionDigits = 2 }

/** A card's chart: bars, lines, areas or a donut, with a legend for more than one series. */
@Composable
fun CardChart(block: UiBlock.Chart) {
    val colors = seriesColors()
    val unit = block.unit?.let { " $it" } ?: ""
    val described = block.labels.indices.joinToString("; ") { index ->
        block.labels[index] + ": " + block.series.joinToString { series -> series.values.getOrNull(index)?.let { "${series.name} ${full.format(it)}$unit" } ?: "${series.name} –" }
    }
    if (block.kind == "pie") return Pie(block, colors, unit, described)
    val ink = MaterialTheme.colorScheme.onSurfaceVariant
    val grid = MaterialTheme.colorScheme.outlineVariant
    val surface = MaterialTheme.colorScheme.surfaceContainerHigh
    val measurer = rememberTextMeasurer()
    val style = TextStyle(color = ink, fontSize = 11.sp)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (block.series.size > 1) Legend(block.series.map { it.name }, colors)
        Canvas(Modifier.fillMaxWidth().height(180.dp).semantics { contentDescription = described }) {
            val values = block.series.flatMap { it.values.filterNotNull() }
            val axis = ticks(min(0.0, values.minOrNull() ?: 0.0), max(0.0, values.maxOrNull() ?: 0.0))
            val left = 40.dp.toPx()
            val bottom = 20.dp.toPx()
            val topPad = 6.dp.toPx()
            val plotWidth = size.width - left
            val plotHeight = size.height - bottom - topPad
            fun y(value: Double) = (topPad + plotHeight - (value - axis.min) / (axis.max - axis.min) * plotHeight).toFloat()
            val band = plotWidth / block.labels.size
            fun x(index: Int) = left + band * index + band / 2
            for (tick in axis.values) {
                drawLine(if (tick == 0.0) ink.copy(alpha = 0.6f) else grid, Offset(left, y(tick)), Offset(size.width, y(tick)), 1.dp.toPx())
                val text = measurer.measure(compact.format(tick), style)
                drawText(text, topLeft = Offset(left - 6.dp.toPx() - text.size.width, y(tick) - text.size.height / 2f))
            }
            val every = ceil(block.labels.size / 6.0).toInt()
            block.labels.forEachIndexed { index, label ->
                if (index % every != 0) return@forEachIndexed
                val text = measurer.measure(if (label.length > 10) label.take(9) + "…" else label, style)
                drawText(text, topLeft = Offset(x(index) - text.size.width / 2f, size.height - text.size.height))
            }
            if (block.kind == "bar") {
                val width = max(2.dp.toPx(), band * 0.72f / block.series.size - 2.dp.toPx())
                block.series.forEachIndexed { s, series ->
                    series.values.forEachIndexed { index, value ->
                        if (value == null) return@forEachIndexed
                        bar(left + band * index + band * 0.14f + s * (width + 2.dp.toPx()), y(0.0), y(value), width, colors[s])
                    }
                }
            } else {
                block.series.forEachIndexed { s, series ->
                    runs(series.values).forEach { run ->
                        val line = Path().apply {
                            run.forEachIndexed { at, index -> if (at == 0) moveTo(x(index), y(series.values[index]!!)) else lineTo(x(index), y(series.values[index]!!)) }
                        }
                        if (block.kind == "area" && run.size > 1) {
                            val area = Path().apply {
                                addPath(line)
                                lineTo(x(run.last()), y(0.0))
                                lineTo(x(run.first()), y(0.0))
                                close()
                            }
                            drawPath(area, colors[s].copy(alpha = if (block.series.size > 1) 0.12f else 0.2f))
                        }
                        drawPath(line, colors[s], style = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
                    }
                    if (block.labels.size <= 24) series.values.forEachIndexed { index, value ->
                        if (value == null) return@forEachIndexed
                        drawCircle(surface, 5.5.dp.toPx(), Offset(x(index), y(value)))
                        drawCircle(colors[s], 3.5.dp.toPx(), Offset(x(index), y(value)))
                    }
                }
            }
        }
    }
}

@Composable
private fun Pie(block: UiBlock.Chart, colors: List<Color>, unit: String, described: String) {
    val values = block.series.firstOrNull()?.values.orEmpty().map { max(0.0, it ?: 0.0) }
    val total = values.sum()
    val surface = MaterialTheme.colorScheme.surfaceContainerHigh
    val empty = MaterialTheme.colorScheme.outlineVariant
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Canvas(Modifier.size(128.dp).semantics { contentDescription = described }) {
            val thickness = size.minDimension * 0.2f
            val inset = Offset(thickness / 2, thickness / 2)
            val ring = Size(size.minDimension - thickness, size.minDimension - thickness)
            if (total == 0.0) return@Canvas drawArc(empty, 0f, 360f, false, inset, ring, style = Stroke(thickness))
            var angle = -90f
            values.forEachIndexed { index, value ->
                val sweep = (value / total * 360).toFloat()
                if (sweep > 0f) drawArc(colors[index], angle, sweep, false, inset, ring, style = Stroke(thickness))
                angle += sweep
            }
            // A thin gap of the surface between slices.
            if (values.count { it > 0 } > 1) {
                angle = -90f
                values.forEach { value ->
                    val radians = angle * PI / 180
                    val center = Offset(size.width / 2, size.height / 2)
                    val inner = ring.width / 2 - thickness / 2
                    val outer = ring.width / 2 + thickness / 2
                    drawLine(
                        surface,
                        center + Offset((cos(radians) * inner).toFloat(), (sin(radians) * inner).toFloat()),
                        center + Offset((cos(radians) * outer).toFloat(), (sin(radians) * outer).toFloat()),
                        2.dp.toPx(),
                    )
                    angle += (value / total * 360).toFloat()
                }
            }
        }
        Legend(
            block.labels,
            colors,
            values.map { if (total == 0.0) "" else "${full.format(it)}$unit · ${(it / total * 100).roundToInt()}%" },
            vertical = true,
        )
    }
}

@Composable
private fun Legend(names: List<String>, colors: List<Color>, values: List<String> = emptyList(), vertical: Boolean = false) {
    val item: @Composable (Int) -> Unit = { index ->
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(colors[index]))
            Text(names[index], style = MaterialTheme.typography.labelMedium)
            values.getOrNull(index)?.takeIf { it.isNotEmpty() }?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    if (vertical) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) { names.indices.forEach { item(it) } }
    } else {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) { names.indices.forEach { item(it) } }
    }
}

/** A bar from `base` to `end`, rounded at the end away from the baseline. */
private fun DrawScope.bar(left: Float, base: Float, end: Float, width: Float, color: Color) {
    val r = min(4.dp.toPx(), min(width / 2, abs(base - end)))
    val top = min(base, end)
    val height = abs(base - end)
    drawRoundRect(color, Offset(left, top), Size(width, height), CornerRadius(r))
    // Square the corners at the baseline again.
    val square = if (end <= base) Offset(left, base - r) else Offset(left, base)
    drawRect(color, square, Size(width, r))
}

/** The indexes of each unbroken run of values, so a null leaves a gap in the line. */
private fun runs(values: List<Double?>): List<List<Int>> {
    val found = mutableListOf<List<Int>>()
    var current = mutableListOf<Int>()
    values.forEachIndexed { index, value ->
        if (value == null) {
            if (current.isNotEmpty()) found += current
            current = mutableListOf()
        } else current += index
    }
    if (current.isNotEmpty()) found += current
    return found
}

private class Axis(val min: Double, val max: Double, val values: List<Double>)

/** About five round numbers from below [low] to above [high]. */
private fun ticks(low: Double, high: Double): Axis {
    val top = if (low == high) low + 1 else high
    val rough = (top - low) / 4
    val power = 10.0.pow(floor(log10(rough)))
    val step = listOf(1.0, 2.0, 2.5, 5.0, 10.0).map { it * power }.first { it >= rough }
    val min = floor(low / step) * step
    val max = ceil(top / step) * step
    return Axis(min, max, generateSequence(min) { it + step }.takeWhile { it <= max + step / 2 }.map { (it / step).roundToInt() * step }.toList())
}

/** Headline numbers in tiles, each with what changed. */
@Composable
fun CardStats(block: UiBlock.Stats) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        block.items.forEach { stat ->
            Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, shape = MaterialTheme.shapes.medium) {
                Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                    Text(stat.label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(stat.value, style = MaterialTheme.typography.titleLarge)
                    stat.change?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.labelMedium,
                            color = when (stat.tone) {
                                "good" -> Color(0xFF2E7D32)
                                "bad" -> MaterialTheme.colorScheme.error
                                else -> MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                }
            }
        }
    }
}

/** Progress bars, each with its label and how far along it is. */
@Composable
fun CardProgress(block: UiBlock.Progress) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        block.items.forEach { item ->
            val share = (item.value / item.max).toFloat()
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(item.label)
                    Text(item.note ?: "${(share * 100).roundToInt()}%", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                LinearProgressIndicator(
                    progress = { share.coerceIn(0f, 1f) },
                    color = if (share > 1f) Color(0xFFC98500) else MaterialTheme.colorScheme.primary,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/** Steps in order, with a dot for each: filled when done, ringed when current. */
@Composable
fun CardTimeline(block: UiBlock.Timeline) {
    val primary = MaterialTheme.colorScheme.primary
    val line = MaterialTheme.colorScheme.outlineVariant
    Column {
        block.items.forEachIndexed { index, step ->
            Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        Modifier.padding(top = 5.dp).size(10.dp).clip(CircleShape).background(
                            when (step.state) {
                                "done", "current" -> primary
                                else -> line
                            },
                        ),
                    )
                    if (index < block.items.lastIndex) Box(Modifier.width(1.dp).weight(1f).background(line))
                }
                Column(Modifier.padding(bottom = 8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        step.time?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        Text(
                            step.title,
                            fontWeight = if (step.state == "current") FontWeight.SemiBold else null,
                            color = if (step.state == "upcoming") MaterialTheme.colorScheme.onSurfaceVariant else Color.Unspecified,
                        )
                    }
                    step.subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        }
    }
}
