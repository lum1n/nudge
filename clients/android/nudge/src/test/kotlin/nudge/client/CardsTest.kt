package nudge.client

import nudge.ffi.ToolPart
import nudge.ffi.ToolStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CardsTest {
    private fun tool(details: String?) = ToolPart("c1", "show_ui", "{}", ToolStatus.DONE, "ok", null, details, null, null)

    private val details = """
        {"ui":{"v":1,"title":"Times","blocks":[{"type":"heading","text":"Free"},{"type":"hologram"},
        {"type":"kv","pairs":[{"label":"Where","value":"Oslo"}]},{"type":"divider"}],
        "fields":[{"name":"guests","label":"Guests","type":"number"},{"name":"kids","label":"Kids","type":"boolean","optional":true}],
        "buttons":[{"id":"go","label":"Book","style":"primary"},{"id":"no","label":"Cancel","skipsFields":true}]},
        "pressed":{"button":"go","by":{"id":"bo","displayName":"Bo"}}}
    """.trimIndent()

    @Test
    fun readsACardAndSkipsBlocksItDoesNotKnow() {
        val card = tool(details).card!!
        assertEquals("Times", card.title)
        assertEquals(listOf(UiBlock.Heading("Free"), UiBlock.KeyValues(listOf(UiBlock.KeyValues.Pair("Where", "Oslo"))), UiBlock.Divider), card.blocks)
        assertEquals(2, card.fields.size)
        assertTrue(card.once)
        assertEquals(UiPressed("go", "Bo"), tool(details).pressed)
        assertNull(tool("""{"needsLogin":true}""").card)
        assertNull(tool("""{"ui":{"v":2,"title":"x"}}""").card)
    }

    @Test
    fun sendsTheFieldsAButtonTakes() {
        val card = tool(details).card!!
        val book = card.buttons[0]
        assertTrue(card.valuesFor(book, emptyMap()).exceptionOrNull() is MissingField)
        assertEquals("""{"guests":4.0,"kids":false}""", card.valuesFor(book, mapOf("guests" to UiValue.Number(4.0))).getOrThrow())
        assertNull(card.valuesFor(card.buttons[1], emptyMap()).getOrThrow())
    }

    @Test
    fun readsMapsChartsAndTheOtherNewBlocks() {
        val card = tool("""
            {"ui":{"v":1,"blocks":[
            {"type":"map","markers":[{"lat":59.91,"lon":10.75,"label":"Oslo S"}],"path":[{"lat":59.9,"lon":10.7},{"lat":60,"lon":10.8}]},
            {"type":"chart","kind":"line","labels":["Jan","Feb"],"series":[{"name":"kr","values":[3,null]}],"unit":"kr"},
            {"type":"stats","items":[{"label":"Spent","value":"4 200 kr","change":"+12%","tone":"bad"}]},
            {"type":"progress","items":[{"label":"Saved","value":3,"max":5}]},
            {"type":"timeline","items":[{"title":"Left","state":"done"}]}]}}
        """.trimIndent()).card!!
        assertEquals(
            listOf(
                UiBlock.Places(listOf(UiBlock.Places.Marker(59.91, 10.75, "Oslo S")), listOf(UiBlock.Places.Point(59.9, 10.7), UiBlock.Places.Point(60.0, 10.8))),
                UiBlock.Chart("line", listOf("Jan", "Feb"), listOf(UiBlock.Chart.Series("kr", listOf(3.0, null))), "kr"),
                UiBlock.Stats(listOf(UiBlock.Stats.Stat("Spent", "4 200 kr", "+12%", "bad"))),
                UiBlock.Progress(listOf(UiBlock.Progress.Bar("Saved", 3.0, 5.0))),
                UiBlock.Timeline(listOf(UiBlock.Timeline.Step("Left", state = "done"))),
            ),
            card.blocks,
        )
    }
}
