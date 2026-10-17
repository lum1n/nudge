package nudge.client

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
            null,
        ),
        TimelineItem.Approval("ap", "p0", "Send", ApprovalStatus.DONE, "Bo", null),
        TimelineItem.Answer("a2", AnswerStatus.DONE, null, listOf(tool("call_api")), null),
        TimelineItem.Answer("a3", AnswerStatus.RUNNING, null, listOf(tool("call_api")), null),
        TimelineItem.Marker("m", MarkerKind.RESET),
    )

    private val TimelineItem.key
        get() = when (this) {
            is TimelineItem.User -> id
            is TimelineItem.Nudge -> id
            is TimelineItem.Approval -> id
            is TimelineItem.Answer -> id
            is TimelineItem.Marker -> id
        }

    @Test
    fun transcriptKeepsMessagesTextAndLogins() {
        val kept = timeline.transcript
        assertEquals(listOf("a1", "a3", "m"), kept.map { it.key })
        assertEquals(2, (kept[0] as TimelineItem.Answer).parts.size)
        assertEquals(0, (kept[1] as TimelineItem.Answer).parts.size)
    }

    @Test
    fun transcriptKeepsSomeoneElsesPrivateAnswer() {
        val secret = TimelineItem.Answer("s", AnswerStatus.DONE, null, emptyList(), Player("bo", "Bo", null))
        assertEquals(listOf(secret), listOf<TimelineItem>(secret).transcript)
    }

    @Test
    fun activityHasNudgesApprovalsToolsAndThinking() {
        val activity = timeline.activity
        assertEquals(listOf("n", "a1", "ap", "a2", "a3"), activity.map { it.key })
        assertEquals(3, (activity[1] as TimelineItem.Answer).parts.size)
    }
}
