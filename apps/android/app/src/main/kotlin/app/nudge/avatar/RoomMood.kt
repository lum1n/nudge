// What the robot shows for a room, from what is going on in it, as in the web app's mood.ts.
package app.nudge.avatar

import app.nudge.R
import app.nudge.text
import nudge.ffi.Approval
import nudge.ffi.ApprovalStatus
import nudge.ffi.AnswerStatus
import nudge.ffi.Live
import nudge.ffi.Part
import nudge.ffi.Status
import nudge.ffi.TimelineItem
import nudge.ffi.ToolStatus

/** After this long with nothing said in the room, the robot dozes off, in ms. */
const val ASLEEP_AFTER = 30 * 60_000.0

/**
 * What the robot shows for a room at [now] (ms since the epoch): someone dictating, an approval
 * waiting, the turn running and what it is doing, or how long it has been quiet. How a turn ended
 * is [ended]'s to say.
 */
fun moodOf(
    timeline: List<TimelineItem>,
    live: Live?,
    approvals: List<Approval>,
    now: Double,
    listening: Boolean = false,
): Mood {
    if (listening) return Mood.LISTENING
    if (approvals.any { it.status == ApprovalStatus.PENDING }) return Mood.WAITING
    if (live?.status is Status.Retrying) return Mood.PUZZLED
    if (live?.status is Status.Compacting) return Mood.THINKING
    if (live?.running == true) {
        val answer = timeline.lastAnswer()
        val last = if (answer?.status == AnswerStatus.RUNNING) answer.parts.lastOrNull() else null
        if (last is Part.Tool && last.tool.status != ToolStatus.DONE) return Mood.WORKING
        if (last is Part.Text && last.text != "") return Mood.SPEAKING
        return Mood.THINKING
    }
    return if (now - lastSaid(timeline) > ASLEEP_AFTER) Mood.ASLEEP else Mood.IDLE
}

fun List<TimelineItem>.lastAnswer(): TimelineItem.Answer? = lastOrNull { it is TimelineItem.Answer } as TimelineItem.Answer?

/** When something was last said in the room, in ms since the epoch; infinitely late for a room without times. */
private fun lastSaid(timeline: List<TimelineItem>): Double {
    var at = 0.0
    for (item in timeline) {
        when (item) {
            is TimelineItem.User -> item.sentAt?.let { at = maxOf(at, it) }
            is TimelineItem.Nudge -> at = maxOf(at, item.firedAt)
            is TimelineItem.Answer -> item.startedAt?.let { at = maxOf(at, it) }
            else -> {}
        }
    }
    // A room with no times at all is a new one, not a sleepy one.
    return if (at == 0.0) Double.POSITIVE_INFINITY else at
}

/**
 * The mood a turn ends with, shown for a moment, when the room's last answer goes from running to
 * [status]; null while it runs, or for a stopped one.
 */
fun ended(status: AnswerStatus): Mood? = when (status) {
    AnswerStatus.DONE -> Mood.HAPPY
    AnswerStatus.FAILED -> Mood.SAD
    AnswerStatus.RUNNING, AnswerStatus.STOPPED -> null
}

/** How long the end of a turn shows, in ms. */
val AFTERGLOW: Map<Mood, Long> = mapOf(Mood.HAPPY to 1600L, Mood.SAD to 4000L)

/** A word on what the robot is doing, beside it by the composer; empty when there's nothing to say. */
fun presenceLabel(mood: Mood, timeline: List<TimelineItem>, live: Live?): String = when (mood) {
    Mood.WORKING -> when (val part = timeline.lastAnswer()?.parts?.lastOrNull()) {
        is Part.Tool -> text(R.string.mood_using, part.tool.name)
        else -> text(R.string.mood_working)
    }
    Mood.THINKING -> text(if (live?.status is Status.Compacting) R.string.mood_compacting else R.string.mood_thinking)
    Mood.SPEAKING -> text(R.string.mood_speaking)
    Mood.WAITING -> text(R.string.mood_waiting)
    Mood.PUZZLED -> text(R.string.mood_puzzled)
    Mood.SAD -> text(R.string.mood_sad)
    Mood.ASLEEP -> text(R.string.mood_asleep)
    Mood.HAPPY, Mood.IDLE, Mood.LISTENING -> ""
}
