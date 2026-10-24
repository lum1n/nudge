package app.nudge.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** The same cases as the CLI's and the web app's: the clients have to agree on a slug. */
class SlugTest {
    @Test
    fun namesAnAssistantsAddressFromItsDisplayName() {
        assertEquals("robin-hood", slugOf("Robin Hood"))
        assertEquals("ase-s-alesund-bot", slugOf("  Åse's  Ålesund-bot! "))
        assertEquals("zoe", slugOf("Zoë"))
        assertEquals("", slugOf("!!!"))
        assertEquals(40, slugOf("x".repeat(60)).length)
    }

    @Test
    fun spellsOutTheLettersNfkdLeavesWhole() {
        assertEquals("bjorn", slugOf("Bjørn"))
        assertEquals("aesa", slugOf("Æsa"))
        assertEquals("orjan-blabaer", slugOf("ØRJAN BLÅBÆR"))
        assertEquals("strasse-strasse", slugOf("Straße STRAẞE"))
        assertEquals("dorde-lukasz-thora", slugOf("Đorđe Łukasz Þóra"))
    }
}
