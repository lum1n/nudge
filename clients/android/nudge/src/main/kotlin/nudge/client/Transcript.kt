package nudge.client

import nudge.ffi.AnswerStatus
import nudge.ffi.Part
import nudge.ffi.TimelineItem

/**
 * The chat itself: messages and what the assistant said. Tool calls, thinking, fired nudges and
 * ended approvals are left to [activity], except the browser waiting on a login; pending approvals
 * wait in the room's own bar. An answer with nothing left to say drops out once it is done.
 */
val List<TimelineItem>.transcript: List<TimelineItem>
    get() = mapNotNull { item ->
        when (item) {
            is TimelineItem.Nudge, is TimelineItem.Approval -> null
            is TimelineItem.Answer -> {
                val kept = item.parts.filter { it is Part.Text || (it is Part.Tool && it.tool.needsLogin) }
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
