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
}
