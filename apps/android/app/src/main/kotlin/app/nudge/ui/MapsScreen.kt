// The server's own map (ADR 18): the regions it holds, anywhere in the world, the ones it fetches
// because someone was there, and the disk they may take. Nothing about where people go leaves the
// server; only the regions' map data comes in.
package app.nudge.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.nudge.explain
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import nudge.ffi.GeoRegion
import nudge.ffi.GeoRegionState
import nudge.ffi.GeoRegionStatus
import nudge.ffi.GeoState
import nudge.ffi.GeoStatus
import nudge.ffi.ServerClient

/** One line on the map's state, for the server's screen. */
fun mapsSummary(status: GeoStatus): String = when (status.state) {
    GeoState.OFF ->
        if (status.follow) "Fetches the region someone is in, anywhere in the world" else "Off"
    GeoState.WORKING -> status.regions.firstOrNull { it.state != GeoRegionState.READY }
        ?.let { "Getting ${it.name} ready" + (it.progress?.let { p -> " (${(p * 100).toInt()}%)" } ?: "…") }
        ?: "Getting ready…"
    GeoState.READY -> status.regions.filter { it.state == GeoRegionState.READY }.joinToString { it.name }
    GeoState.FAILED -> status.error ?: status.regions.firstNotNullOfOrNull { it.error } ?: "Failed"
}

private fun gigabytes(bytes: Double) = "%.1f GB".format(bytes / (1 shl 30))

private fun regionNote(region: GeoRegionStatus): String = when (region.state) {
    GeoRegionState.WAITING -> "Waiting"
    GeoRegionState.DOWNLOADING, GeoRegionState.IMPORTING ->
        "Getting ${region.step ?: "it"} ready" + (region.progress?.let { " (${(it * 100).toInt()}%)" } ?: "…")
    GeoRegionState.READY ->
        (region.bytes?.let { gigabytes(it) + ", " } ?: "") +
            if (region.byOwner) "kept" else "because someone was there; dropped first to make room"
    GeoRegionState.FAILED -> region.error ?: "Failed"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MapsScreen(client: ServerClient, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<GeoStatus?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }

    fun act(action: suspend () -> GeoStatus) = scope.launch {
        try {
            status = action()
            problem = null
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    // Followed while a region is on its way, so its progress shows.
    LaunchedEffect(Unit) {
        while (true) {
            runCatching { client.geo() }.onSuccess { status = it }.onFailure { problem = explain(it) }
            delay(if (status?.state == GeoState.WORKING) 3_000 else 30_000)
        }
    }

    val current = status
    if (adding && current != null) {
        AddRegionDialog(
            client,
            have = current.regions.map { it.id }.toSet(),
            pick = { region ->
                adding = false
                val owners = current.regions.filter { it.byOwner }.map { it.id }
                act { client.configureGeo(owners + region.id, null, null) }
            },
            close = { adding = false },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Maps") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Text(
                    "Addresses, places and routes for reminders when someone gets somewhere, from OpenStreetMap. " +
                        "The server downloads the map of each region and keeps it, so where people go stays here.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (current == null) {
                item { Text(problem ?: "Loading…") }
                return@LazyColumn
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Follow people")
                        Text(
                            "Fetch the region someone's phone says they are in, anywhere in the world. A trip abroad takes a few minutes to an hour to be ready.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(checked = current.follow, onCheckedChange = { on -> act { client.configureGeo(null, on, null) } })
                }
            }
            item {
                var limit by remember(current.limitGb) { mutableFloatStateOf(current.limitGb.toFloat()) }
                Column {
                    Text("At most ${limit.toInt()} GB on disk (${gigabytes(current.usedBytes)} now)")
                    Slider(
                        value = limit,
                        onValueChange = { limit = it },
                        valueRange = 5f..200f,
                        onValueChangeFinished = { act { client.configureGeo(null, null, limit.toDouble()) } },
                    )
                }
            }
            items(current.regions, key = { it.id }) { region ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(region.name)
                        Text(
                            regionNote(region),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (region.state == GeoRegionState.FAILED) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = {
                        val owners = current.regions.filter { it.byOwner && it.id != region.id }.map { it.id }
                        // A region fetched for someone becomes one an owner keeps, or goes.
                        act { client.configureGeo(if (region.byOwner) owners else owners + region.id, null, null) }
                    }) { Text(if (region.byOwner) "Remove" else "Keep") }
                }
            }
            item {
                TextButton(onClick = { adding = true }) {
                    Icon(Icons.Outlined.Add, null)
                    Text("Add a region", Modifier.padding(start = 8.dp))
                }
            }
            problem?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
        }
    }
}

/** Every region in the world, to search by name: countries, and states and provinces of large ones. */
@Composable
private fun AddRegionDialog(client: ServerClient, have: Set<String>, pick: (GeoRegion) -> Unit, close: () -> Unit) {
    var regions by remember { mutableStateOf<List<GeoRegion>?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    LaunchedEffect(Unit) {
        runCatching { client.geoRegions() }.onSuccess { regions = it }.onFailure { problem = explain(it) }
    }
    val names = remember(regions) { regions.orEmpty().associate { it.id to it.name } }
    val shown = regions.orEmpty()
        .filter { it.parent != null && it.id !in have && (query.isBlank() || it.name.contains(query.trim(), ignoreCase = true)) }
        .sortedBy { it.name }
        .take(50)
    AlertDialog(
        onDismissRequest = close,
        title = { Text("Add a region") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = query, onValueChange = { query = it }, label = { Text("Country, state or province") }, singleLine = true)
                when {
                    problem != null -> Text(problem!!, color = MaterialTheme.colorScheme.error)
                    regions == null -> Text("Loading the world's regions…")
                    else -> LazyColumn(Modifier.heightIn(max = 360.dp)) {
                        items(shown, key = { it.id }) { region ->
                            Column(Modifier.fillMaxWidth().clickable { pick(region) }.padding(vertical = 8.dp)) {
                                Text(region.name)
                                region.parent?.let { names[it] }?.let {
                                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = close) { Text("Close") } },
    )
}
