package nudge.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalTest {
    private fun ObservedTerminal.receive(json: String) = receive(frameOf(json)!!)

    @Test
    fun addsOutputToTheCommandItBelongsTo() {
        val terminal = ObservedTerminal()
        assertNull(terminal.state.value.commands)
        terminal.receive(
            """{"type":"commands","commands":[{"id":"c1","command":"ls","status":"running","output":"a\n","startedAt":1},{"id":"c2","command":"rm -r old","status":"waiting","approval":"a1","output":"","startedAt":2}]}""",
        )
        terminal.receive("""{"type":"output","id":"c1","chunk":"b\n"}""")
        terminal.receive("""{"type":"output","id":"c9","chunk":"x"}""")
        val commands = terminal.state.value.commands!!
        assertEquals("a\nb\n", commands[0].output)
        assertEquals("", commands[1].output)
        assertEquals("a1", commands[1].approval)

        terminal.receive(
            """{"type":"commands","commands":[{"id":"c1","command":"ls","status":"failed","output":"a\nb\n","exitCode":2,"startedAt":1,"endedAt":3}]}""",
        )
        assertEquals(TerminalCommand("c1", "ls", status = "failed", output = "a\nb\n", exitCode = 2, startedAt = 1.0, endedAt = 3.0), terminal.state.value.commands!!.single())
    }
}
