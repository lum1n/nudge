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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.Visibility
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.nudge.avatar.LocalRobotLook
import app.nudge.avatar.Portrait
import java.text.DateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale
import nudge.client.needsLogin
import nudge.ffi.AnswerStatus
import nudge.ffi.ApprovalStatus
import nudge.ffi.MarkerKind
import nudge.ffi.Part
import nudge.ffi.PendingMessage
import nudge.ffi.PendingState
import nudge.ffi.PromptedBy
import nudge.ffi.TimelineItem
import nudge.ffi.ToolPart
import nudge.ffi.ToolStatus

/**
 * One item of a room's transcript: a message, an answer or a marker; nudges and ended approvals
 * are in the activity ([ActivityRow]). `assistant` is the assistant's display name, over its answers;
 * `openBrowser` opens the room's browser, to log in where it asks; `openActivity` shows what a
 * working answer is doing.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun TimelineRow(item: TimelineItem, me: String?, assistant: String, openBrowser: () -> Unit, openActivity: () -> Unit) {
    when (item) {
        // Someone else's private message: the server sent it empty, so it is a line, not a bubble.
        is TimelineItem.User -> if (item.privateTo != null && item.text.isEmpty()) {
            PrivateLine("${item.privateTo?.displayName} sent a private message")
        } else {
            val mine = item.author == null || item.author?.id == me
            val sender = if (mine) "You" else item.author?.displayName ?: "Someone"
            Column(
                Modifier.fillMaxWidth().spokenAs(sender, item.text, item.sentAt, onlyYou = item.privateTo != null),
                horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
            ) {
                if (item.privateTo != null) OnlyYou()
                Bubble(item.text, mine, if (mine) null else item.author?.displayName, sentAt = item.sentAt)
            }
        }
        is TimelineItem.Nudge, is TimelineItem.Approval -> {}
        is TimelineItem.Answer -> when (val owner = item.privateTo) {
            null -> AnswerCard(item, assistant, mine = false, openBrowser, openActivity)
            else -> if (owner.id == me) {
                AnswerCard(item, assistant, mine = true, openBrowser, openActivity)
            } else {
                PrivateLine(
                    if (item.status == AnswerStatus.RUNNING) "Answering ${owner.displayName} privately…"
                    else "Answered ${owner.displayName} privately",
                )
            }
        }
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

/**
 * A message as TalkBack reads it, in one go: who sent it, that only the reader sees it, what it
 * says and when.
 */
private fun Modifier.spokenAs(sender: String, text: String, sentAt: Double?, onlyYou: Boolean) = clearAndSetSemantics {
    contentDescription = listOfNotNull(
        sender,
        if (onlyYou) "only you" else null,
        withHidden(text).text.trim(),
        sentAt?.let(::timeOfDay),
    ).joinToString(", ")
}

/**
 * An answer on a surface of its own, under the assistant's name and when it started, so it reads
 * apart from the messages around it and from the answer before. `mine`: it answers the reader's
 * private message.
 */
@Composable
private fun AnswerCard(
    answer: TimelineItem.Answer,
    assistant: String,
    mine: Boolean,
    openBrowser: () -> Unit,
    openActivity: () -> Unit,
) {
    // One no one asked for just now, to a nudge or a watch, takes the colours of what prompted it.
    val colors = MaterialTheme.colorScheme
    val (surface, accent, onAccent) = when (answer.promptedBy) {
        PromptedBy.NUDGE -> Triple(colors.tertiaryContainer.copy(alpha = 0.5f), colors.tertiaryContainer, colors.onTertiaryContainer)
        PromptedBy.WATCH -> Triple(colors.secondaryContainer.copy(alpha = 0.5f), colors.secondaryContainer, colors.onSecondaryContainer)
        null -> Triple(colors.surfaceContainerLow, colors.surfaceContainerLow, colors.onSurface)
    }
    Surface(
        color = surface,
        shape = MaterialTheme.shapes.extraLarge,
        // Read as one: the assistant's name, when, and what it said; its buttons and tools stay apart.
        modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Portrait(appearance = LocalRobotLook.current, size = 22.dp)
                Text(assistant, style = MaterialTheme.typography.titleSmall)
                answer.promptedBy?.let { PromptedChip(it, accent, onAccent) }
                answer.startedAt?.let {
                    Text(timeOfDay(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (mine) OnlyYou()
            Answer(answer, openBrowser, openActivity)
        }
    }
}

/** The nudge or watch an answer answers. */
@Composable
private fun PromptedChip(prompt: PromptedBy, color: Color, content: Color) {
    Surface(color = color, contentColor = content, shape = CircleShape) {
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(
                if (prompt == PromptedBy.NUDGE) Icons.Outlined.NotificationsActive else Icons.Outlined.Visibility,
                null,
                Modifier.size(14.dp),
            )
            Text(if (prompt == PromptedBy.NUDGE) "Nudge" else "Watch", style = MaterialTheme.typography.labelMedium)
        }
    }
}

/** A time of day, such as 14:32, the way the reader's locale writes it. */
fun timeOfDay(at: Double): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at.toLong()))

/** Where a new day starts in the transcript: "Today", "Yesterday" or the date. */
@Composable
fun DayDivider(at: Double) {
    val day = Instant.ofEpochMilli(at.toLong()).atZone(ZoneId.systemDefault()).toLocalDate()
    val today = LocalDate.now()
    val label = when (day) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> {
            val skeleton = if (day.year == today.year) "EEEEdMMMM" else "EEEEdMMMMy"
            val pattern = android.text.format.DateFormat.getBestDateTimePattern(Locale.getDefault(), skeleton)
            DateTimeFormatter.ofPattern(pattern).format(day)
        }
    }
    Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f))
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 10.dp),
        )
        HorizontalDivider(Modifier.weight(1f))
    }
}

@Composable
fun Bubble(text: String, mine: Boolean, author: String?, faded: Boolean = false, sentAt: Double? = null) {
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
                Text(withHidden(text), Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
            }
        }
        sentAt?.let {
            Text(
                timeOfDay(it),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PendingRow(message: PendingMessage, retry: () -> Unit, dismiss: () -> Unit) {
    // Read as one with its state; Retry and Dismiss stay buttons of their own.
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, horizontalAlignment = Alignment.End) {
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

/** One thing in a room's activity: a nudge or watch that fired, an ended approval, or an answer's tools. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ActivityRow(item: TimelineItem, openBrowser: () -> Unit) {
    when (item) {
        is TimelineItem.Nudge -> if (item.privateTo != null && item.text.isEmpty()) {
            PrivateLine("A nudge for ${item.privateTo?.displayName}")
        } else Surface(
            color = MaterialTheme.colorScheme.secondaryContainer,
            shape = MaterialTheme.shapes.large,
            modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        ) { Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Outlined.NotificationsActive, "Nudge")
            Column {
                Text(withHidden(item.text))
                Text(
                    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(item.firedAt.toLong())),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        } }
        is TimelineItem.Approval -> if (item.privateTo != null && item.summary.isEmpty()) {
            PrivateLine("An approval for ${item.privateTo?.displayName} ended")
        } else {
            // Ended: nothing left to decide.
            ApprovalCard(item.summary, item.status, item.decidedBy) {}
        }
        is TimelineItem.Answer -> Answer(item, openBrowser, openActivity = {})
        is TimelineItem.User, is TimelineItem.Marker -> {}
    }
}

/**
 * The assistant's answer as it streams: its text in the transcript; what it thought and the tools
 * it used in the activity.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Answer(answer: TimelineItem.Answer, openBrowser: () -> Unit, openActivity: () -> Unit) {
    Column(Modifier.fillMaxWidth().animateContentSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        answer.parts.forEach { part ->
            when (part) {
                is Part.Text -> SelectionContainer { Text(markdown(part.text)) }
                is Part.Reasoning -> Expandable("Thinking") {
                    Text(part.text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                // The browser stopped for a login only a person can type.
                is Part.Tool -> if (part.tool.needsLogin) {
                    Button(onClick = openBrowser, shapes = ButtonDefaults.shapes()) {
                        Icon(Icons.Outlined.Language, null, Modifier.size(ButtonDefaults.IconSize))
                        Spacer(Modifier.size(ButtonDefaults.IconSpacing))
                        Text("Open the room's browser to log in")
                    }
                } else {
                    Tool(part.tool)
                }
            }
        }
        when (answer.status) {
            // At work with nothing to say yet: tapping it shows what it is doing.
            AnswerStatus.RUNNING -> if (answer.parts.isEmpty()) {
                Row(
                    Modifier.clickable(onClick = openActivity),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    LoadingIndicator(Modifier.size(32.dp))
                    Text("Working…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
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
                    ToolStatus.PENDING, ToolStatus.RUNNING ->
                        LoadingIndicator(Modifier.size(20.dp).semantics { contentDescription = "Running" })
                    ToolStatus.DONE -> Icon(
                        if (tool.isError == true) Icons.Outlined.ErrorOutline else Icons.Outlined.CheckCircle,
                        if (tool.isError == true) "Failed" else "Done",
                        Modifier.size(16.dp),
                        tint = if (tool.isError == true) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    )
                }
                Text(tool.name, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
            // What a running tool is doing: the last line it printed, such as browse's `Clicking "Search"…`.
            if (tool.status != ToolStatus.DONE && !open) {
                tool.output?.lineSequence()?.map { it.trim() }?.lastOrNull { it.isNotEmpty() }?.let { line ->
                    Text(
                        line.take(100),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
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
        modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
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
            Text(withHidden(summary))
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

/** Something private to someone else happened here; the server didn't say what. */
@Composable
private fun PrivateLine(text: String) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Lock, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Marks what is the reader's alone, so they know the others don't see it. */
@Composable
private fun OnlyYou() {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Lock, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.tertiary)
        Text("Only you", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
    }
}

/** `⟦EMAIL1⟧` and the like: a value the server hid from this player. */
private val PLACEHOLDER = Regex("⟦[A-Z]+\\d+⟧")

private val HIDDEN = SpanStyle(
    fontFamily = FontFamily.Monospace,
    fontStyle = FontStyle.Italic,
    background = androidx.compose.ui.graphics.Color(0x33808080),
)

/** Text with each hidden value shown as "hidden". */
fun withHidden(text: String): AnnotatedString = buildAnnotatedString {
    var last = 0
    for (match in PLACEHOLDER.findAll(text)) {
        append(text.substring(last, match.range.first))
        withStyle(HIDDEN) { append(" hidden ") }
        last = match.range.last + 1
    }
    append(text.substring(last))
}

/** `**bold**`, `*italic*` and `` `code` `` in a line of the answer, hidden values marked; the rest as written. */
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
        val hidden = PLACEHOLDER.matchAt(text, i)
        if (hidden != null) {
            withStyle(HIDDEN) { append(" hidden ") }
            i = hidden.range.last + 1
            continue
        }
        if (span("**", SpanStyle(fontWeight = FontWeight.Bold))) continue
        if (span("`", SpanStyle(fontFamily = FontFamily.Monospace))) continue
        if (span("*", SpanStyle(fontStyle = FontStyle.Italic))) continue
        append(text[i])
        i++
    }
}
