package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.R
import kotlinx.coroutines.flow.MutableStateFlow
import nudge.client.ListsState
import nudge.client.NudgeList
import nudge.client.ObservedLists
import nudge.client.observeLists
import nudge.ffi.NudgeClient
import nudge.ffi.PanelStatus

/** The room's shared lists, such as shopping and to-dos; the assistant edits them too. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ListsScreen(client: NudgeClient, roomId: String, close: () -> Unit) {
    val observed = remember(client, roomId) { MutableStateFlow<ObservedLists?>(null) }
    DisposableEffect(client, roomId) {
        val lists = client.observeLists(roomId)
        observed.value = lists
        onDispose { lists.close() }
    }
    val lists by observed.collectAsStateWithLifecycle()
    val state = lists?.state?.collectAsStateWithLifecycle()?.value ?: ListsState()

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(stringResource(R.string.room_lists)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, stringResource(R.string.room_close)) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            val status = state.status
            val all = state.lists
            when {
                status is PanelStatus.Closed && status.code.toInt() == 4404 -> Text(
                    stringResource(R.string.room_lists_off),
                    Modifier.align(Alignment.Center).padding(32.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                all == null -> LoadingIndicator(Modifier.align(Alignment.Center))
                else -> ListsContent(all, state.error, lists ?: return@Box)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ListsContent(all: List<NudgeList>, error: String?, lists: ObservedLists) {
    val drafts = remember { mutableStateMapOf<String, String>() }
    var newList by remember { mutableStateOf("") }
    fun add(list: String) {
        val text = drafts[list]?.trim().orEmpty()
        if (text.isEmpty()) return
        lists.add(text, list)
        drafts.remove(list)
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
    ) {
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }
        all.forEach { list ->
            item(key = "header:${list.name}") { ListHeader(list.name, lists) }
            item(key = "items:${list.name}") {
                Column(verticalArrangement = Arrangement.spacedBy(ListItemDefaults.SegmentedGap)) {
                    list.items.forEachIndexed { index, item ->
                        SegmentedListItem(
                            checked = item.done,
                            onCheckedChange = { lists.toggle(item, list.name) },
                            shapes = ListItemDefaults.segmentedShapes(index = index, count = list.items.size),
                            leadingContent = { Checkbox(checked = item.done, onCheckedChange = null) },
                            supportingContent = { Text(item.by) },
                            trailingContent = {
                                IconButton(onClick = { lists.remove(item, list.name) }) { Icon(Icons.Outlined.Close, stringResource(R.string.room_remove)) }
                            },
                        ) {
                            Text(item.text, textDecoration = if (item.done) TextDecoration.LineThrough else null)
                        }
                    }
                }
            }
            item(key = "add:${list.name}") {
                OutlinedTextField(
                    value = drafts[list.name].orEmpty(),
                    onValueChange = { drafts[list.name] = it },
                    placeholder = { Text(stringResource(R.string.room_lists_add_to, list.name)) },
                    singleLine = true,
                    shape = MaterialTheme.shapes.large,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { add(list.name) }),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
            }
        }
        item(key = "new") {
            Section(stringResource(R.string.room_lists_new))
            OutlinedTextField(
                value = newList,
                onValueChange = { newList = it },
                placeholder = { Text(stringResource(R.string.room_name)) },
                singleLine = true,
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.fillMaxWidth(),
            )
            if (newList.isNotBlank()) {
                OutlinedTextField(
                    value = drafts[newList].orEmpty(),
                    onValueChange = { drafts[newList] = it },
                    placeholder = { Text(stringResource(R.string.room_lists_first_item)) },
                    singleLine = true,
                    shape = MaterialTheme.shapes.large,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        add(newList)
                        newList = ""
                    }),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun ListHeader(name: String, lists: ObservedLists) {
    var menu by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) { Section(name.replaceFirstChar { it.uppercase() }) }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.room_lists_actions)) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.room_lists_clear_done)) }, onClick = {
                    menu = false
                    lists.clearDone(name)
                })
                DropdownMenuItem(text = { Text(stringResource(R.string.room_lists_delete)) }, onClick = {
                    menu = false
                    lists.delete(name)
                })
            }
        }
    }
}
