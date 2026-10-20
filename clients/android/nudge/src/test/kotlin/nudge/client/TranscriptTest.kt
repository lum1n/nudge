package nudge.client

import java.time.ZoneId
import java.time.ZonedDateTime
import nudge.ffi.AnswerStatus
import nudge.ffi.ApprovalStatus
import nudge.ffi.MarkerKind
import nudge.ffi.Part
import nudge.ffi.Player
import nudge.ffi.TimelineItem
import nudge.ffi.ToolPart
import nudge.ffi.ToolStatus
import org.junit.Assert.assertEquals
import org.junit.Test

class TranscriptTest {
    private fun tool(name: String, details: String? = null) =
        Part.Tool(ToolPart(name, name, "{}", ToolStatus.DONE, "ok", null, details, null, null))

    private val timeline = listOf(
        TimelineItem.Nudge("n", "Watch w1: 2 new", 1.0, null),
        TimelineItem.Answer(
            "a1", AnswerStatus.DONE, null,
            listOf(Part.Reasoning("hm"), tool("call_api"), tool("browse", """{"needsLogin":true}"""), Part.Text("Two new mails.")),
            null, null,
        ),
        TimelineItem.Approval("ap", "p0", "Send", ApprovalStatus.DONE, "Bo", null),
        TimelineItem.Answer("a2", AnswerStatus.DONE, null, listOf(tool("call_api")), null, null),
        TimelineItem.Answer("a3", AnswerStatus.RUNNING, null, listOf(tool("call_api")), null, null),
        TimelineItem.Marker("m", MarkerKind.RESET),
    )

    @Test
    fun transcriptKeepsMessagesTextAndLogins() {
        val kept = timeline.transcript
        assertEquals(listOf("a1", "a3", "m"), kept.map { it.itemId })
        assertEquals(2, (kept[0] as TimelineItem.Answer).parts.size)
        assertEquals(0, (kept[1] as TimelineItem.Answer).parts.size)
    }

    @Test
    fun transcriptKeepsSomeoneElsesPrivateAnswer() {
        val secret = TimelineItem.Answer("s", AnswerStatus.DONE, null, emptyList(), null, Player("bo", "Bo", null))
        assertEquals(listOf(secret), listOf<TimelineItem>(secret).transcript)
    }

    @Test
    fun activityHasNudgesApprovalsToolsAndThinking() {
        val activity = timeline.activity
        assertEquals(listOf("n", "a1", "ap", "a2", "a3"), activity.map { it.itemId })
        assertEquals(3, (activity[1] as TimelineItem.Answer).parts.size)
    }

    @Test
    fun dayStartsMarkTheFirstTimedItemOfEachDay() {
        val zone = ZoneId.of("Europe/Oslo")
        fun at(day: Int, hour: Int) = ZonedDateTime.of(2026, 10, day, hour, 0, 0, 0, zone).toInstant().toEpochMilli().toDouble()
        fun user(id: String, sentAt: Double?) = TimelineItem.User(id, id, null, sentAt, null, null, null)
        fun answer(id: String, startedAt: Double?) =
            TimelineItem.Answer(id, AnswerStatus.DONE, null, listOf(Part.Text(id)), startedAt, null)
        val items = listOf(
            user("a", at(18, 9)), answer("b", at(18, 9)), TimelineItem.Marker("m", MarkerKind.COMPACTED),
            user("c", at(19, 23)), answer("d", null), answer("e", at(20, 0)),
        )
        assertEquals(mapOf("a" to at(18, 9), "c" to at(19, 23), "e" to at(20, 0)), items.dayStarts(zone))
    }
}
