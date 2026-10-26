package nudge.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AttachmentsTest {
    @Test
    fun scalesPhotosDownToTheLongSideKeepingTheirType() {
        assertEquals(Scaling(2048, 1536, "image/jpeg"), scaling("image/jpeg", 4032, 3024, 2048))
        assertEquals(Scaling(410, 2048, "image/png"), scaling("image/png", 1000, 5000, 2048))
    }

    @Test
    fun leavesSmallImagesAndGifsAndMakesOtherImageTypesJpegs() {
        assertNull(scaling("image/webp", 800, 600, 2048))
        assertNull(scaling("image/gif", 4000, 4000, 2048))
        assertNull(scaling("image/jpeg", -1, -1, 2048))
        assertEquals(Scaling(800, 600, "image/jpeg"), scaling("image/heic", 800, 600, 2048))
    }

    @Test
    fun saysSizes() {
        assertEquals("900 B", sizeLabel(900))
        assertEquals("240 KB", sizeLabel(240 * 1024))
        assertEquals("1.3 MB", sizeLabel((1.25 * 1024 * 1024).toLong()))
    }
}
