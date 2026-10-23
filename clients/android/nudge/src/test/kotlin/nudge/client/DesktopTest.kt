package nudge.client

import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DesktopTest {
    private fun ObservedDesktop.receive(json: String) = receive(frameOf(json)!!)

    @Test
    fun patchesComeInOrderWithTheScreenSize() {
        val desktop = ObservedDesktop()
        val whole = byteArrayOf(1, 2, 3)
        val part = byteArrayOf(4)
        desktop.receive(
            """{"type":"frame","data":"${Base64.getEncoder().encodeToString(whole)}","x":0,"y":0,"width":1280,"height":800,"screen":{"width":1280,"height":800}}""",
        )
        desktop.receive(
            """{"type":"frame","data":"${Base64.getEncoder().encodeToString(part)}","x":64,"y":87,"width":32,"height":20,"screen":{"width":1280,"height":800}}""",
        )
        val first = desktop.patches.tryReceive().getOrNull()!!
        val second = desktop.patches.tryReceive().getOrNull()!!
        assertArrayEquals(whole, first.png)
        assertArrayEquals(part, second.png)
        assertEquals(listOf(64, 87, 32, 20), listOf(second.x, second.y, second.width, second.height))
        assertEquals(1280 to 800, desktop.state.value.screenWidth to desktop.state.value.screenHeight)
        assertNull(desktop.patches.tryReceive().getOrNull())
    }

    @Test
    fun keepsWindowsAppsAndWhatTheAssistantDoes() {
        val desktop = ObservedDesktop()
        desktop.receive("""{"type":"apps","apps":["editor","calc"]}""")
        desktop.receive("""{"type":"windows","windows":[{"ref":"e1","title":"Notes","app":"python3"}]}""")
        desktop.receive("""{"type":"status","text":"Clicking button \"Save\""}""")
        desktop.receive("""{"type":"control","holder":"Bo","you":false}""")
        var state = desktop.state.value
        assertEquals(listOf("editor", "calc"), state.apps)
        assertEquals(listOf(DesktopWindow("e1", "Notes", "python3")), state.windows)
        assertEquals("Clicking button \"Save\"", state.working)
        assertEquals(DesktopControl("Bo", false), state.control)

        desktop.receive("""{"type":"status","text":""}""")
        desktop.receive("""{"type":"error","message":"There is no app called \"x\"."}""")
        state = desktop.state.value
        assertNull(state.working)
        assertEquals("There is no app called \"x\".", state.error)
    }
}
