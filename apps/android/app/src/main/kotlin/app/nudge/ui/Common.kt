package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.ListItemShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** One row of a [group], given its place in the group's shape. */
typealias GroupRow = @Composable (ListItemShapes) -> Unit

/** A titled group of rows, shaped as one segmented list: rounded at its ends, joined between. */
fun LazyListScope.group(title: String, rows: List<GroupRow>) {
    item(key = "title:$title") { Section(title) }
    if (rows.isEmpty()) return
    item(key = "group:$title") {
        Column(verticalArrangement = Arrangement.spacedBy(ListItemDefaults.SegmentedGap)) {
            rows.forEachIndexed { index, row ->
                row(ListItemDefaults.segmentedShapes(index = index, count = rows.size))
            }
        }
    }
}

@Composable
fun Section(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 8.dp),
    )
}

/** Behind segmented groups: their rows are the surface colour, so the page is a step darker. */
@Composable
fun groupedBackground() = MaterialTheme.colorScheme.surfaceContainer

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun groupedTopBarColors() = TopAppBarDefaults.topAppBarColors(
    containerColor = groupedBackground(),
    scrolledContainerColor = groupedBackground(),
)
