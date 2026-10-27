package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Savings
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.R
import app.nudge.explain
import app.nudge.text
import java.text.NumberFormat
import java.util.Currency
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import nudge.client.ObservedProject
import nudge.client.ProjectState
import nudge.client.ProjectTask
import nudge.client.ProjectView
import nudge.client.observeProject
import nudge.ffi.NudgeClient
import nudge.ffi.PanelStatus

/**
 * The room's project, as the assistant runs it with coding agents: its status with Pause and
 * Resume, the brief, milestones and their tasks, the agents at work, its VM, secrets and spend.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ProjectScreen(client: NudgeClient, roomId: String, close: () -> Unit) {
    val observed = remember(client, roomId) { MutableStateFlow<ObservedProject?>(null) }
    DisposableEffect(client, roomId) {
        val project = client.observeProject(roomId)
        observed.value = project
        onDispose { project.close() }
    }
    val project by observed.collectAsStateWithLifecycle()
    val state = project?.state?.collectAsStateWithLifecycle()?.value ?: ProjectState()

    Scaffold(
        containerColor = groupedBackground(),
        topBar = {
            TopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(state.project?.name ?: stringResource(R.string.project_title)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, stringResource(R.string.room_close)) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val status = state.status
            val shown = state.project
            when {
                status is PanelStatus.Closed && status.code.toInt() == 4404 -> Message(stringResource(R.string.project_off))
                !state.loaded -> LoadingIndicator(Modifier.align(Alignment.Center))
                shown == null -> Message(stringResource(R.string.project_none))
                else -> ProjectContent(shown, state.error, project ?: return@Box)
            }
        }
    }
}

@Composable
private fun Message(text: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ProjectContent(view: ProjectView, error: String?, project: ObservedProject) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    fun run(action: suspend () -> Unit) {
        busy = true
        scope.launch {
            try {
                action()
                problem = null
            } catch (failure: Exception) {
                problem = explain(failure)
            } finally {
                busy = false
            }
        }
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
    ) {
        (problem ?: error)?.let { item(key = "problem") { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }
        item(key = "status") {
            Row(
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatusChip(projectStatus(view.status))
                when (view.status) {
                    "running", "planning", "gate" -> FilledTonalButton(
                        onClick = { run { project.pause() } },
                        enabled = !busy,
                        shapes = ButtonDefaults.shapes(),
                    ) {
                        Icon(Icons.Outlined.Pause, null, Modifier.padding(end = 8.dp))
                        Text(stringResource(R.string.project_pause))
                    }
                    "paused" -> FilledTonalButton(
                        onClick = { run { project.resume() } },
                        enabled = !busy,
                        shapes = ButtonDefaults.shapes(),
                    ) {
                        Icon(Icons.Outlined.PlayArrow, null, Modifier.padding(end = 8.dp))
                        Text(stringResource(R.string.project_resume))
                    }
                    else -> {}
                }
            }
        }
        if (view.brief.isNotBlank() || view.repo != null) {
            group(
                text(R.string.project_brief),
                listOfNotNull<GroupRow>(
                    view.brief.takeIf { it.isNotBlank() }?.let { brief -> { shapes -> SegmentedListItem(shapes = shapes) { Text(brief) } } },
                    view.repo?.let { repo ->
                        { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                overlineContent = { Text(stringResource(R.string.project_repo)) },
                                onClick = { if (repo.startsWith("https://")) uri.openUri(repo) },
                            ) { Text(repo) }
                        }
                    },
                ),
            )
        }

        view.milestones.forEach { milestone ->
            item(key = "milestone:${milestone.id}") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { Section(milestone.title) }
                    StatusChip(milestoneStatus(milestone.status))
                }
            }
            item(key = "tasks:${milestone.id}") {
                Column(verticalArrangement = Arrangement.spacedBy(androidx.compose.material3.ListItemDefaults.SegmentedGap)) {
                    if (milestone.tasks.isEmpty()) {
                        Text(
                            stringResource(R.string.project_no_tasks),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                    }
                    milestone.tasks.forEachIndexed { index, task ->
                        TaskRow(task, androidx.compose.material3.ListItemDefaults.segmentedShapes(index = index, count = milestone.tasks.size)) {
                            uri.openUri(it)
                        }
                    }
                }
            }
        }

        val live = view.liveTasks
        group(
            text(R.string.project_agents),
            if (live.isEmpty()) {
                listOf { shapes ->
                    SegmentedListItem(
                        shapes = shapes,
                        leadingContent = { Icon(Icons.Outlined.SmartToy, null) },
                        supportingContent = if (view.maxAgents > 0) ({ Text(stringResource(R.string.project_agents_max, "${view.maxAgents}")) }) else null,
                    ) { Text(stringResource(R.string.project_agents_none)) }
                }
            } else {
                live.map { task ->
                    { shapes ->
                        SegmentedListItem(
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.SmartToy, null) },
                            supportingContent = {
                                Text(listOfNotNull(task.session?.host, task.session?.state, task.branch).joinToString(" · "))
                            },
                        ) { Text(task.title) }
                    }
                }
            },
        )

        view.vm?.let { vm ->
            group(
                text(R.string.project_vm),
                listOf { shapes ->
                    SegmentedListItem(
                        shapes = shapes,
                        leadingContent = { Icon(Icons.Outlined.Dns, null) },
                        supportingContent = { Text(vm.host) },
                        trailingContent = {
                            Text(stringResource(if (vm.ready) R.string.project_vm_ready else R.string.project_vm_not_ready))
                        },
                    ) { Text(vm.name) }
                },
            )
        }

        group(
            text(R.string.project_secrets),
            listOf { shapes ->
                SegmentedListItem(shapes = shapes, leadingContent = { Icon(Icons.Outlined.Key, null) }) {
                    Text(view.secrets.joinToString().ifEmpty { stringResource(R.string.project_secrets_none) })
                }
            },
        )

        group(
            text(R.string.project_spend),
            listOf { shapes ->
                val money = remember { NumberFormat.getCurrencyInstance().apply { currency = Currency.getInstance("USD") } }
                SegmentedListItem(shapes = shapes, leadingContent = { Icon(Icons.Outlined.Savings, null) }) {
                    Text(
                        view.budgetUsd?.let { stringResource(R.string.project_spend_of, money.format(view.spendUsd), money.format(it)) }
                            ?: money.format(view.spendUsd),
                    )
                }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun TaskRow(task: ProjectTask, shapes: androidx.compose.material3.ListItemShapes, open: (String) -> Unit) {
    val pr = task.pr
    SegmentedListItem(
        shapes = shapes,
        onClick = { if (pr != null && pr.url.startsWith("https://")) open(pr.url) },
        supportingContent = {
            val lines = listOfNotNull(
                task.note,
                pr?.let {
                    val name = it.number?.let { number -> stringResource(R.string.project_pr, "$number") }
                        ?: stringResource(R.string.project_pr_plain)
                    val ci = when (it.ci) {
                        "pending" -> stringResource(R.string.project_ci_pending)
                        "passing" -> stringResource(R.string.project_ci_passing)
                        "failing" -> stringResource(R.string.project_ci_failing)
                        else -> null
                    }
                    listOfNotNull(name, ci).joinToString(" · ")
                },
            )
            if (lines.isNotEmpty()) Text(lines.joinToString("\n"))
        },
        trailingContent = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusChip(taskStatus(task.status))
                if (pr != null) Icon(Icons.AutoMirrored.Outlined.OpenInNew, null)
            }
        },
    ) { Text(task.title) }
}

@Composable
private fun StatusChip(label: String) {
    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun projectStatus(status: String): String = when (status) {
    "planning" -> stringResource(R.string.project_status_planning)
    "running" -> stringResource(R.string.project_status_running)
    "paused" -> stringResource(R.string.project_status_paused)
    "gate" -> stringResource(R.string.project_status_gate)
    "done" -> stringResource(R.string.project_status_done)
    else -> status
}

@Composable
private fun milestoneStatus(status: String): String = when (status) {
    "planned" -> stringResource(R.string.project_milestone_planned)
    "active" -> stringResource(R.string.project_milestone_active)
    "gate" -> stringResource(R.string.project_status_gate)
    "merged" -> stringResource(R.string.project_milestone_merged)
    else -> status
}

@Composable
private fun taskStatus(status: String): String = when (status) {
    "todo" -> stringResource(R.string.project_task_todo)
    "running" -> stringResource(R.string.project_status_running)
    "review" -> stringResource(R.string.project_task_review)
    "done" -> stringResource(R.string.project_status_done)
    "blocked" -> stringResource(R.string.project_task_blocked)
    "skipped" -> stringResource(R.string.project_task_skipped)
    else -> status
}
