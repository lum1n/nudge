package app.nudge.avatar

import kotlin.math.abs
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PoseTest {
    private fun Pose.values() = doubleArrayOf(
        bob, tilt, stretch, gazeX, gazeY, eyeLeft, eyeRight, cheeks, brows, browSlant, glow, shimmer, sparks, sparkLength,
        sway, dozing,
    )

    @Test
    fun theSameMomentGivesTheSamePose() {
        for (mood in Mood.entries) assertEquals(pose(mood, 12.34), pose(mood, 12.34))
    }

    @Test
    fun staysInRangeInEveryMoodForAMinuteOfFrames() {
        for (mood in Mood.entries) {
            var t = 0.0
            while (t < 60) {
                val p = pose(mood, t)
                for (value in p.values()) assertTrue(value.isFinite())
                assertTrue(abs(p.gazeX) <= 1)
                assertTrue(abs(p.gazeY) <= 1)
                assertTrue(p.eyeLeft >= 0 && p.eyeLeft <= 1.35)
                assertTrue(p.sparks >= 0 && p.sparks <= 1)
                assertTrue(p.cheeks <= 1)
                t += 1.0 / 30
            }
        }
    }

    @Test
    fun blinksEveryFewSecondsQuickly() {
        var closed = 0.0
        var blinks = 0
        var shut = false
        var t = 0.0
        while (t < 60) {
            val now = blink(t) > 0.9
            if (now) closed += 0.01
            if (now && !shut) blinks += 1
            shut = now
            t += 0.01
        }
        assertTrue(blinks in 11..29)
        assertTrue(closed < 3)
    }

    @Test
    fun followsTheVoiceItIsGiven() {
        val quiet = pose(Mood.SPEAKING, 3.0, level = 0.0)
        val loud = pose(Mood.SPEAKING, 3.0, level = 1.0)
        assertTrue(loud.eyeLeft > quiet.eyeLeft)
        assertTrue(loud.bob < quiet.bob)
    }

    @Test
    fun blendsFieldByField() {
        val happy = pose(Mood.HAPPY, 1.0)
        assertEquals(REST, blend(REST, happy, 0.0))
        assertEquals(happy, blend(REST, happy, 1.0))
        assertEquals(happy.cheeks / 2, blend(REST, happy, 0.5).cheeks, 1e-9)
    }

    private class Case(val mood: String, val t: Double, val level: Double?, val pose: DoubleArray)

    // From the web app's engine (apps/web/src/avatar/pose.ts) at the same moments.
    private val web = listOf(
        Case("idle", 12.34, null, doubleArrayOf(1.018082831500739, -1.7986930418992415, 1.004072331326003, -0.179760391014861, -0.08830669330491218, 1.0, 1.0, 0.0, 0.0, 0.0, 0.75, -1.0, 0.0, 1.0, 0.8813968035414727, 0.0)),
        Case("thinking", 3.7, null, doubleArrayOf(-0.9079809994790939, 5.964574501457377, 0.9963680760020837, 0.793800537755041, -0.6123693319956135, 0.03673837113205017, 0.03673837113205017, 0.0, 0.15, -0.2, 0.6536474508437583, 0.9899999999999998, 0.0, 1.0, -0.9473263538541915, 0.0)),
        Case("speaking", 5.25, null, doubleArrayOf(0.3938302758304153, -2.5579204930622783, 1.0145392878919215, 0.1, 0.0, 0.9653928789192158, 0.9653928789192158, 0.2226964394596079, 0.0, 0.0, 0.8453928789192158, -1.0, 0.0, 1.0, -0.05924062789371426, 0.0)),
        Case("speaking", 2.0, 0.6, doubleArrayOf(-1.7999999999999996, -2.8531695488854605, 1.018, 0.1, 0.0, 1.0, 1.0, 0.24, 0.0, 0.0, 0.8799999999999999, -1.0, 0.0, 1.0, 0.6965510290629972, 0.0)),
        Case("working", 7.9, null, doubleArrayOf(-0.31286893008046096, 5.904827052466019, 0.9987485242796782, 0.6214481157398057, 0.65, 0.8, 0.8, 0.0, 0.2, 0.0, 0.85, -1.0, 0.15, 1.0, 0.059240627893714384, 0.0)),
        Case("waiting", 1.85, null, doubleArrayOf(0.23344536385590517, 7.347880794884119e-16, 1.0018675629108473, 0.0, 0.0, 1.1, 1.1, 0.1, 0.0, 0.0, 0.85, -1.0, 0.3000000000000001, 0.7000000000000001, 0.8124868780056812, 0.0)),
        Case("happy", 0.4, null, doubleArrayOf(-3.082052971103157, 4.524135262330098, 1.0192628310693947, 0.0, -0.1, 1.0, 1.0, 0.85, 0.0, 0.0, 1.0, -1.0, 0.8852566213878946, 1.1311539728327369, 0.4566292373937131, 0.0)),
        Case("puzzled", 9.1, null, doubleArrayOf(1.975376681190276, 8.015770597371045, 1.0079015067247612, 0.5, -0.35, 1.15, 0.6, 0.0, 0.25, 0.6, 0.75, -1.0, 0.2, 0.5, -0.9785564922995037, 0.0)),
        Case("sad", 4.4, null, doubleArrayOf(5.4702282018339785, -4.0, 0.9773511410091699, -0.1, 0.6, 0.8, 0.8, 0.0, 0.35, 1.0, 0.45, -1.0, 0.0, 1.0, -0.35029397687825453, 0.0)),
        Case("asleep", 20.0, null, doubleArrayOf(6.598076211353316, -6.133974596215562, 1.0129903810567666, 0.0, 0.3, 0.07, 0.07, 0.2, 0.0, 0.0, 0.3, -1.0, 0.0, 1.0, 0.3464101615137754, 1.0)),
        Case("listening", 6.6, 0.3, doubleArrayOf(-1.409016994374947, -4.048943483704846, 0.9935278640450004, 0.0, -0.05, 1.1740000000000002, 1.1740000000000002, 0.0, 0.0, 0.0, 0.8600000000000001, -1.0, 0.43, 0.78, 0.9995608365087943, 0.0)),
        Case("idle", 15.2, null, doubleArrayOf(-1.9021130325903077, 0.60790551250102, 0.9923915478696388, 0.2614493439585203, -0.10645341726194602, 1.0, 1.0, 0.0, 0.0, 0.0, 0.75, -1.0, 0.0, 1.0, -0.7378332790417277, 0.0)),
    )

    @Test
    fun movesAsTheWebAppsRobotDoes() {
        for (case in web) {
            val mood = Mood.valueOf(case.mood.uppercase())
            assertArrayEquals("${case.mood} at ${case.t}", case.pose, pose(mood, case.t, case.level).values(), 1e-9)
        }
        assertEquals(0.9386310214920834, blink(2.52), 1e-9)
        assertEquals(0.5214131293672937, blink(2.59), 1e-9)
        assertEquals(0.9968440728064134, blink(3.99), 1e-9)
        assertEquals(0.6818623214269244, voice(1.1), 1e-9)
        assertEquals(0.30520087811389496, voice(2.9), 1e-9)
        assertEquals(0.6297021747086546, hash(3.0), 1e-9)
        assertArrayEquals(
            doubleArrayOf(-0.705342302750968, 0.46352549156242123, 1.0044083893921936, 0.175, -0.03, 1.0, 1.0, 0.255, 0.0, 0.0, 0.825, -1.0, 0.238167787843871, 1.0229006727063226, 0.27800688222955, 0.0),
            blend(REST, pose(Mood.HAPPY, 1.0), 0.3).values(),
            1e-9,
        )
    }

    @Test
    fun tintsAsTheWebAppDoes() {
        assertEquals("#3aaef4", tint(tint("#1438f5", "#19e6f0", 0.6), "#ffffff", 0.15))
        assertEquals("#401796", tint("#5b21d6", "#000000", 0.3))
        assertEquals(0xff1438f5.toInt(), argb(NUDGE.body.first))
    }
}
