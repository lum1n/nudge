package app.nudge.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import java.text.DateFormat
import java.util.Date
import nudge.ffi.AnswerStatus
import nudge.ffi.ApprovalStatus
import nudge.ffi.MarkerKind
import nudge.ffi.Part
import nudge.ffi.PendingMessage
import nudge.ffi.PendingState
import nudge.ffi.TimelineItem
import nudge.ffi.ToolPart
import nudge.ffi.ToolStatus

val TimelineItem.itemId: String
    get() = when (this) {
        is TimelineItem.User -> id
        is TimelineItem.Nudge -> id
        is TimelineItem.Approval -> id
        is TimelineItem.Answer -> id
        is TimelineItem.Marker -> id
    }

/** One item of a room's timeline. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun TimelineRow(item: TimelineItem, me: String?, decide: (String, Boolean) -> Unit) {
    when (item) {
        is TimelineItem.User -> {
            val mine = item.author == null || item.author?.id == me
            Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
                Bubble(item.text, mine, if (mine) null else item.author?.displayName)
            }
        }
        is TimelineItem.Nudge -> Surface(
            color = MaterialTheme.colorScheme.secondaryContainer,
            shape = MaterialTheme.shapes.large,
        ) { Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Outlined.NotificationsActive, null)
            Column {
                Text(item.text)
                Text(
                    DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(item.firedAt.toLong())),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        } }
        is TimelineItem.Approval -> ApprovalCard(item.summary, item.status, item.decidedBy) { approve ->
            decide(item.approvalId, approve)
        }
        is TimelineItem.Answer -> Answer(item)
        is TimelineItem.Marker -> Row(verticalAlignment = Alignment.CenterVertically) {
            HorizontalDivider(Modifier.weight(1f))
            Text(
                if (item.kind == MarkerKind.COMPACTED) "Earlier messages summarized" else "Conversation started over",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 8.dp),
            )
            HorizontalDivider(Modifier.weight(1f))
        }
    }
}

@Composable
fun Bubble(text: String, mine: Boolean, author: String?, faded: Boolean = false) {
    Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        author?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // Rounded all round but at the corner nearest the sender.
        Surface(
            shape = if (mine) {
                RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp, bottomStart = 24.dp, bottomEnd = 6.dp)
            } else {
                RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp, bottomStart = 6.dp, bottomEnd = 24.dp)
            },
            color = if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.widthIn(max = 520.dp).alpha(if (faded) 0.6f else 1f),
        ) {
            SelectionContainer {
                Text(text, Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PendingRow(message: PendingMessage, retry: () -> Unit, dismiss: () -> Unit) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Bubble(message.text, mine = true, author = null, faded = true)
        val small = MaterialTheme.typography.labelSmall
        when (val state = message.state) {
            is PendingState.Sending -> Text("Sending…", style = small, color = MaterialTheme.colorScheme.onSurfaceVariant)
            is PendingState.Waiting ->
                Text("Waiting for the connection", style = small, color = MaterialTheme.colorScheme.onSurfaceVariant)
            is PendingState.Failed -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Not sent: ${state.error}", style = small, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = retry, shapes = ButtonDefaults.shapes()) { Text("Retry") }
                TextButton(onClick = dismiss, shapes = ButtonDefaults.shapes()) { Text("Dismiss") }
            }
        }
    }
}

/** The assistant's answer: its text, what it thought, and the tools it used, as they stream. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Answer(answer: TimelineItem.Answer) {
    Column(Modifier.fillMaxWidth().animateContentSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        answer.parts.forEach { part ->
            when (part) {
                is Part.Text -> SelectionContainer { Text(markdown(part.text)) }
                is Part.Reasoning -> Expandable("Thinking") {
                    Text(part.text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                is Part.Tool -> Tool(part.tool)
            }
        }
        when (answer.status) {
            AnswerStatus.RUNNING -> if (answer.parts.isEmpty()) LoadingIndicator(Modifier.size(40.dp))
            AnswerStatus.STOPPED ->
                Text("Stopped", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            AnswerStatus.FAILED -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Outlined.ErrorOutline, null, tint = MaterialTheme.colorScheme.error)
                Text(answer.error ?: "Couldn't answer", color = MaterialTheme.colorScheme.error)
            }
            AnswerStatus.DONE -> {}
        }
    }
}

@Composable
private fun Expandable(title: String, content: @Composable () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column {
        Text(
            (if (open) "▾ " else "▸ ") + title,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clickable { open = !open },
        )
        if (open) content()
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Tool(tool: ToolPart) {
    var open by remember { mutableStateOf(false) }
    Surface(
        onClick = { open = !open },
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (tool.status) {
                    ToolStatus.PENDING, ToolStatus.RUNNING -> LoadingIndicator(Modifier.size(20.dp))
                    ToolStatus.DONE -> Icon(
                        if (tool.isError == true) Icons.Outlined.ErrorOutline else Icons.Outlined.CheckCircle,
                        null,
                        Modifier.size(16.dp),
                        tint = if (tool.isError == true) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    )
                }
                Text(tool.name, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
            if (open) {
                if (tool.argsJson != "{}") {
                    Text(tool.argsJson, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
                (tool.result ?: tool.output)?.let { output ->
                    Text(
                        output + if (tool.truncated == true) " …" else "",
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (tool.isError == true) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 30,
                    )
                }
            }
        }
    }
}

/** An action the assistant wants to take, waiting for a member to approve it. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ApprovalCard(summary: String, status: ApprovalStatus, decidedBy: String?, decide: (Boolean) -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.extraLarge,
        color = if (status == ApprovalStatus.PENDING) {
            MaterialTheme.colorScheme.tertiaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceContainer
        },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.PanTool, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.tertiary)
                Text(
                    if (status == ApprovalStatus.PENDING) "Needs approval" else "Approval",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
            Text(summary)
            if (status == ApprovalStatus.PENDING) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { decide(true) }, shapes = ButtonDefaults.shapes()) {
                        Icon(Icons.Outlined.Check, null, Modifier.size(ButtonDefaults.IconSize))
                        Spacer(Modifier.size(ButtonDefaults.IconSpacing))
                        Text("Approve")
                    }
                    OutlinedButton(onClick = { decide(false) }, shapes = ButtonDefaults.shapes()) { Text("Deny") }
                }
            } else {
                val by = decidedBy?.let { " by $it" } ?: ""
                Text(
                    when (status) {
                        ApprovalStatus.APPROVED -> "Approved$by"
                        ApprovalStatus.DENIED -> "Denied$by"
                        ApprovalStatus.DONE -> "Approved$by, done"
                        ApprovalStatus.FAILED -> "Approved$by, but it failed"
                        ApprovalStatus.PENDING -> ""
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** `**bold**`, `*italic*` and `` `code` `` in a line of the answer; the rest as written. */
fun markdown(text: String): AnnotatedString = buildAnnotatedString {
    var i = 0
    fun span(open: String, style: SpanStyle): Boolean {
        if (!text.startsWith(open, i)) return false
        val end = text.indexOf(open, i + open.length)
        if (end < 0 || end == i + open.length || text.substring(i + open.length, end).contains('\n')) return false
        withStyle(style) { append(text.substring(i + open.length, end)) }
        i = end + open.length
        return true
    }
    while (i < text.length) {
        if (span("**", SpanStyle(fontWeight = FontWeight.Bold))) continue
        if (span("`", SpanStyle(fontFamily = FontFamily.Monospace))) continue
        if (span("*", SpanStyle(fontStyle = FontStyle.Italic))) continue
        append(text[i])
        i++
    }
}
