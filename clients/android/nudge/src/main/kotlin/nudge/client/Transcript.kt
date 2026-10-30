package nudge.client

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import nudge.ffi.AnswerStatus
import nudge.ffi.Part
import nudge.ffi.TimelineItem

val TimelineItem.itemId: String
    get() = when (this) {
        is TimelineItem.User -> id
        is TimelineItem.Nudge -> id
        is TimelineItem.Approval -> id
        is TimelineItem.Answer -> id
        is TimelineItem.Marker -> id
    }

/** When it happened, in ms since the epoch: a message when it was sent, an answer when it started, a nudge when it fired. */
val TimelineItem.time: Double?
    get() = when (this) {
        is TimelineItem.User -> sentAt
        is TimelineItem.Answer -> startedAt
        is TimelineItem.Nudge -> firedAt
        is TimelineItem.Approval, is TimelineItem.Marker -> null
    }

/**
 * The items each day of the transcript starts with, by id, with their time in ms since the epoch;
 * days in [zone]. Items without a time don't start one.
 */
fun List<TimelineItem>.dayStarts(zone: ZoneId = ZoneId.systemDefault()): Map<String, Double> {
    val starts = mutableMapOf<String, Double>()
    var day: LocalDate? = null
    for (item in this) {
        val at = item.time ?: continue
        val its = Instant.ofEpochMilli(at.toLong()).atZone(zone).toLocalDate()
        if (its != day) starts[item.itemId] = at
        day = its
    }
    return starts
}

/**
 * The chat itself: messages and what the assistant said. Tool calls, thinking, fired nudges and
 * ended approvals are left to [activity], except the browser waiting on a login and cards (ADR 27); pending approvals
 * wait in the room's own bar. An answer with nothing left to say drops out once it is done.
 */
val List<TimelineItem>.transcript: List<TimelineItem>
    get() = mapNotNull { item ->
        when (item) {
            is TimelineItem.Nudge, is TimelineItem.Approval -> null
            is TimelineItem.Answer -> {
                val kept = item.parts.filter { it is Part.Text || (it is Part.Tool && (it.tool.needsLogin || it.tool.card != null)) }
                // Someone else's private answer comes without parts, and stays as a line saying so.
                val othersPrivate = item.privateTo != null && item.parts.isEmpty()
                if (kept.isEmpty() && item.status == AnswerStatus.DONE && !othersPrivate) null else item.copy(parts = kept)
            }
            is TimelineItem.User, is TimelineItem.Marker -> item
        }
    }

/**
 * What happened behind the chat, oldest first: fired nudges and watches, ended approvals, and each
 * answer's tool calls and thinking (its text stays in the chat).
 */
val List<TimelineItem>.activity: List<TimelineItem>
    get() = mapNotNull { item ->
        when (item) {
            is TimelineItem.Nudge, is TimelineItem.Approval -> item
            is TimelineItem.Answer -> {
                val kept = item.parts.filter { it !is Part.Text }
                if (kept.isEmpty()) null else item.copy(parts = kept)
            }
            is TimelineItem.User, is TimelineItem.Marker -> null
        }
    }
