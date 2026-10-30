package app.nudge.avatar

import app.nudge.EnglishTexts
import nudge.ffi.Approval
import nudge.ffi.ApprovalStatus
import nudge.ffi.AnswerStatus
import nudge.ffi.Live
import nudge.ffi.Part
import nudge.ffi.Status
import nudge.ffi.TimelineItem
import nudge.ffi.ToolPart
import nudge.ffi.ToolStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RoomMoodTest {
    init {
        EnglishTexts.install()
    }

    private val now = 1_800_000_000_000.0
    private val said = listOf<TimelineItem>(TimelineItem.User("m1", "hi", null, now - 1000, null, null, null, emptyList()))
    private val quiet = Live(running = false, status = null)
    private val running = Live(running = true, status = null)

    private fun answer(vararg parts: Part, status: AnswerStatus = AnswerStatus.RUNNING) =
        listOf<TimelineItem>(TimelineItem.Answer("a1", status, null, parts.toList(), now - 500, null, null))

    private fun tool(status: ToolStatus) =
        Part.Tool(ToolPart("c", "browser", "{}", status, null, null, null, null, null))

    @Test
    fun idleInAQuietRoomAndAsleepInOneQuietForLong() {
        assertEquals(Mood.IDLE, moodOf(said, quiet, emptyList(), now))
        assertEquals(Mood.ASLEEP, moodOf(said, quiet, emptyList(), now + ASLEEP_AFTER + 1000))
        // A room with no times at all is new, not sleepy.
        assertEquals(Mood.IDLE, moodOf(emptyList(), quiet, emptyList(), now))
        assertEquals(Mood.IDLE, moodOf(emptyList(), null, emptyList(), now))
    }

    @Test
    fun thinksWorksAndSpeaksWhileTheTurnRuns() {
        assertEquals(Mood.THINKING, moodOf(answer(), running, emptyList(), now))
        assertEquals(Mood.THINKING, moodOf(answer(Part.Reasoning("hm")), running, emptyList(), now))
        assertEquals(Mood.WORKING, moodOf(answer(tool(ToolStatus.RUNNING)), running, emptyList(), now))
        assertEquals(Mood.THINKING, moodOf(answer(tool(ToolStatus.DONE)), running, emptyList(), now))
        assertEquals(Mood.SPEAKING, moodOf(answer(Part.Text("Here")), running, emptyList(), now))
        assertEquals(Mood.THINKING, moodOf(answer(Part.Text("")), running, emptyList(), now))
    }

    @Test
    fun waitsOnAnApprovalAndIsPuzzledWhileRetryingBeforeAnythingElse() {
        val approvals = listOf(Approval("p1", "Send it", ApprovalStatus.PENDING, now, null, null, null))
        assertEquals(Mood.WAITING, moodOf(said, running, approvals, now))
        val retrying = Live(running = true, status = Status.Retrying(2, now, "529"))
        assertEquals(Mood.PUZZLED, moodOf(said, retrying, emptyList(), now))
        assertEquals(Mood.THINKING, moodOf(said, Live(running = true, status = Status.Compacting), emptyList(), now))
        assertEquals(Mood.LISTENING, moodOf(said, quiet, approvals, now, listening = true))
    }

    @Test
    fun endsATurnHappyOrSad() {
        assertEquals(Mood.HAPPY, ended(AnswerStatus.DONE))
        assertEquals(Mood.SAD, ended(AnswerStatus.FAILED))
        assertNull(ended(AnswerStatus.STOPPED))
        assertNull(ended(AnswerStatus.RUNNING))
    }

    @Test
    fun saysWhatItIsDoing() {
        assertEquals("Using browser…", presenceLabel(Mood.WORKING, answer(tool(ToolStatus.RUNNING)), running))
        assertEquals("Thinking…", presenceLabel(Mood.THINKING, answer(), running))
        assertEquals("Tidying up older messages…", presenceLabel(Mood.THINKING, said, Live(true, Status.Compacting)))
        assertEquals("", presenceLabel(Mood.IDLE, said, quiet))
    }
}
