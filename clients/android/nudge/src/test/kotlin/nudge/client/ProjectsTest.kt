package nudge.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProjectsTest {
    private fun ObservedProject.receive(json: String) = receive(frameOf(json)!!)

    @Test
    fun readsTheProjectLeniently() {
        val project = ObservedProject()
        assertFalse(project.state.value.loaded)
        project.receive("""{"type":"project","project":null}""")
        assertTrue(project.state.value.loaded)
        assertNull(project.state.value.project)

        project.receive(
            """{"type":"project","project":{"id":"p1","name":"Shop","status":"someday","brief":"A shop","new":1,
            "milestones":[{"id":"m1","title":"MVP","status":"active","tasks":[
              {"id":"t1","title":"Cart","criteria":["adds"],"status":"running","session":{"host":"vm","id":"s1"},"pr":{"url":"https://x/1","number":1,"ci":"flaky"}},
              {"id":"t2","title":"Pay","criteria":[],"status":"todo","pr":null}]}],
            "vm":{"name":"shop","host":"shop.exe.xyz","ready":true},"secrets":["GH"],"spendUsd":1.5,"maxAgents":2,"updatedAt":5}}""",
        )
        val view = project.state.value.project!!
        assertEquals("someday", view.status)
        assertEquals(listOf("t1"), view.liveTasks.map { it.id })
        assertEquals("flaky", view.milestones[0].tasks[0].pr?.ci)
        assertNull(view.budgetUsd)
        assertEquals(listOf("GH"), view.secrets)
    }
}
