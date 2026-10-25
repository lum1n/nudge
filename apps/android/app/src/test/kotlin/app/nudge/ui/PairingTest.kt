package app.nudge.ui

import app.nudge.EnglishTexts
import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import nudge.ffi.PairingCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingTest {
    init {
        EnglishTexts.install()
    }

    private val link = "nudge://pair?server=https%3A%2F%2Fnudge.example&assistant=robin&code=ABCD-1234"
    private val code = PairingCode("ABCD-1234", link, 1_800_000_000_000.0)

    @Test
    fun theQrCodeReadsBackAsThePairingLink() {
        val modules = qrModules(link)
        assertTrue(modules.all { it.size == modules.size })
        // Drawn as the screen draws it: four pixels a module, a quiet zone of four modules.
        val scale = 4
        val side = (modules.size + 8) * scale
        val pixels = IntArray(side * side) { i ->
            val x = (i % side) / scale - 4
            val y = (i / side) / scale - 4
            val dark = y in modules.indices && x in modules.indices && modules[y][x]
            if (dark) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
        }
        val bitmap = BinaryBitmap(HybridBinarizer(RGBLuminanceSource(side, side, pixels)))
        assertEquals(link, QRCodeReader().decode(bitmap).text)
    }

    @Test
    fun namesTheServerTheAppAsksFor() {
        assertEquals("https://nudge.example", Pairing(code, "Cy", self = false).server)
        assertNull(Pairing(code.copy(link = "not a link"), "Cy", self = false).server)
    }

    @Test
    fun saysWhoScansIt() {
        assertEquals(
            "Have Cy scan this with the Nudge app on their phone, or type the code in it. The server is https://nudge.example.",
            Pairing(code, "Cy", self = false).hint,
        )
        assertTrue(Pairing(code, "Ann", self = true).hint.startsWith("Scan this with the Nudge app on your other device"))
    }

    @Test
    fun theMessageHasTheLinkAndTheCode() {
        val message = Pairing(code, "Cy", self = false).message("Robin")
        assertTrue(message.contains(link))
        assertTrue(message.contains("ABCD-1234 at https://nudge.example"))
        assertTrue(message.startsWith("Sign in to Robin on Nudge as Cy"))
    }
}
