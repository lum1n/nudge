// The Nudge robot's motion, apart from how it is drawn: what it feels and the time give a pose of
// plain numbers. The same engine as the web app's (apps/web/src/avatar/pose.ts), number for
// number, so the robot moves the same everywhere; nothing here is random, the same moment always
// gives the same pose.
package app.nudge.avatar

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** What the robot is doing, from what the room is doing. */
enum class Mood {
    /** Nothing going on: breathes, blinks, looks around. */
    IDLE,
    /** Someone is dictating: eyes wide, following the voice. */
    LISTENING,
    /** A turn is running: looks up, the visor shimmers. */
    THINKING,
    /** The answer is coming: eyes bounce with it. */
    SPEAKING,
    /** A tool is running: looks down at its work. */
    WORKING,
    /** An approval waits for someone: nudges, the sparks flash. */
    WAITING,
    /** A turn just ended well. */
    HAPPY,
    /** Retrying after an error. */
    PUZZLED,
    /** A turn failed. */
    SAD,
    /** Nothing for a long while. */
    ASLEEP,
}

data class Pose(
    /** Up and down, in units of the 200-wide canvas; up is negative. */
    val bob: Double,
    /** Head tilt in degrees, clockwise. */
    val tilt: Double,
    /** Squash and stretch of the whole robot: 1 is at rest, more is taller. */
    val stretch: Double,
    /** Where it looks, -1 to 1 (right and down are positive). */
    val gazeX: Double,
    val gazeY: Double,
    /** How open each eye is, 0 to about 1.3. */
    val eyeLeft: Double,
    val eyeRight: Double,
    /** How far the cheeks push up into the eyes, 0 to 1: a smile. */
    val cheeks: Double,
    /** How far the brows come down over the eyes, 0 to 1. */
    val brows: Double,
    /** The brows' slant: positive lifts the inner ends (sad), negative drops them (cross). */
    val browSlant: Double,
    /** How bright the eyes glow, 0 to 1. */
    val glow: Double,
    /** The shimmer across the visor, 0 to 1 along it; negative for none. */
    val shimmer: Double,
    /** The sparks: how visible, 0 to 1, and how long, 0 to 1.2. */
    val sparks: Double,
    val sparkLength: Double,
    /** The ribbon's sway, -1 to 1. */
    val sway: Double,
    /** The sleeping "z"s, 0 to 1. */
    val dozing: Double,
)

private const val TAU = PI * 2

/** A number in [0, 1) that depends only on [n]. */
fun hash(n: Double): Double {
    val x = sin(n * 127.1 + 311.7) * 43758.5453
    return x - floor(x)
}

private fun clamp(x: Double, lo: Double, hi: Double) = min(hi, max(lo, x))
private fun smooth(x: Double): Double {
    val t = clamp(x, 0.0, 1.0)
    return t * t * (3 - 2 * t)
}
fun mix(a: Double, b: Double, k: Double) = a + (b - a) * k

/**
 * How closed the eyes are from blinking, 0 to 1: a blink every few seconds, now and then two.
 * [every] is the average gap in seconds.
 */
fun blink(t: Double, every: Double = 3.6): Double {
    val slot = floor(t / every)
    val at = slot * every + hash(slot) * (every - 0.6)
    fun one(start: Double): Double {
        val d = (t - start) / 0.16
        return if (d < 0 || d > 1) 0.0 else sin(d * PI)
    }
    return max(one(at), if (hash(slot + 0.5) < 0.2) one(at + 0.24) else 0.0)
}

/** Where it glances: a new spot every [every] seconds, eased between, -1 to 1 on each axis. */
private fun glance(t: Double, every: Double, seed: Double): Pair<Double, Double> {
    val slot = floor(t / every)
    val into = (t - slot * every) / every
    // It moves to the next spot quickly, then rests there.
    val k = smooth(into / 0.18)
    fun spotX(s: Double) = hash(s * 3.1 + seed) * 2 - 1
    fun spotY(s: Double) = (hash(s * 7.7 + seed) * 2 - 1) * 0.6
    return mix(spotX(slot - 1), spotX(slot), k) to mix(spotY(slot - 1), spotY(slot), k)
}

/** A made-up voice when no real one is given: syllables with pauses between words. */
fun voice(t: Double): Double {
    val syllables = 0.5 + 0.5 * sin(t * TAU * 4.2) * sin(t * TAU * 1.3 + 1)
    val words = smooth(sin(t * TAU * 0.45) * 2 + 1.2)
    return clamp(syllables * words, 0.0, 1.0)
}

/** Still, eyes open, looking a little to the side: the robot when it isn't moving. */
val REST = Pose(
    bob = 0.0,
    tilt = 0.0,
    stretch = 1.0,
    gazeX = 0.25,
    gazeY = 0.0,
    eyeLeft = 1.0,
    eyeRight = 1.0,
    cheeks = 0.0,
    brows = 0.0,
    browSlant = 0.0,
    glow = 0.75,
    shimmer = -1.0,
    sparks = 0.0,
    sparkLength = 1.0,
    sway = 0.0,
    dozing = 0.0,
)

/** The pose of [mood] at [t] seconds; [level] is the voice's loudness, 0 to 1, made up when null. */
fun pose(mood: Mood, t: Double, level: Double? = null): Pose {
    val breath = sin((t * TAU) / 4)
    val base = REST.copy(
        bob = breath * 2,
        stretch = 1 + breath * 0.008,
        sway = sin((t * TAU) / 5.3),
    )
    val shut = 1 - blink(t)
    val voice = level ?: voice(t)

    return when (mood) {
        Mood.IDLE -> {
            val (x, y) = glance(t, 2.8, 1.0)
            // A twinkle of the sparks now and then.
            val slot = floor(t / 7)
            val twinkle = if (hash(slot + 9) < 0.5) sin(clamp((t - slot * 7 - 2) / 0.8, 0.0, 1.0) * PI) else 0.0
            base.copy(
                gazeX = 0.15 + x * 0.55,
                gazeY = y * 0.5,
                tilt = x * 3,
                eyeLeft = shut,
                eyeRight = shut,
                sparks = twinkle * 0.6,
            )
        }
        Mood.LISTENING -> {
            val lean = sin((t * TAU) / 3) * 0.5 + 0.5
            base.copy(
                gazeX = 0.0,
                gazeY = -0.05,
                tilt = -6 + lean * 2,
                bob = base.bob * 0.5 - voice * 2,
                eyeLeft = (1.12 + voice * 0.18) * shut,
                eyeRight = (1.12 + voice * 0.18) * shut,
                glow = 0.8 + voice * 0.2,
                sparks = 0.25 + voice * 0.6,
                sparkLength = 0.6 + voice * 0.6,
            )
        }
        Mood.THINKING -> {
            // Eyes go up and to the side and wander a little, as if reading the ceiling.
            val wander = sin(t * TAU * 0.6)
            base.copy(
                gazeX = 0.45 + wander * 0.35,
                gazeY = -0.7 + sin(t * TAU * 0.9) * 0.1,
                tilt = 4 + wander * 2,
                eyeLeft = 0.85 * (1 - blink(t, 5.0)),
                eyeRight = 0.85 * (1 - blink(t, 5.0)),
                brows = 0.15,
                browSlant = -0.2,
                glow = 0.7 + 0.15 * sin(t * TAU * 1.5),
                shimmer = (t * 0.7) % 1.6,
            )
        }
        Mood.SPEAKING -> base.copy(
            gazeX = 0.1,
            gazeY = 0.0,
            bob = base.bob - voice * 3,
            stretch = 1 + voice * 0.03,
            tilt = sin(t * TAU * 0.35) * 3,
            eyeLeft = (0.82 + voice * 0.3) * shut,
            eyeRight = (0.82 + voice * 0.3) * shut,
            cheeks = 0.15 + voice * 0.15,
            glow = 0.7 + voice * 0.3,
        )
        Mood.WORKING -> {
            // Down at its hands, with a quick look up now and then.
            val slot = floor(t / 3.2)
            val up = if (hash(slot + 4) < 0.4) sin(clamp((t - slot * 3.2 - 1) / 0.7, 0.0, 1.0) * PI) else 0.0
            val scan = sin(t * TAU * 0.8)
            base.copy(
                gazeX = 0.35 + scan * 0.3,
                gazeY = mix(0.65, -0.1, up),
                tilt = 5 + scan,
                eyeLeft = mix(0.8, 1.0, up) * shut,
                eyeRight = mix(0.8, 1.0, up) * shut,
                brows = 0.2 * (1 - up),
                glow = 0.85,
                sparks = 0.15,
            )
        }
        Mood.WAITING -> {
            // Two nudges, a pause, two nudges: someone has to decide.
            val beat = (t % 1.6) / 1.6
            val nudge = max(
                sin(clamp(beat / 0.15, 0.0, 1.0) * PI),
                sin(clamp((beat - 0.2) / 0.15, 0.0, 1.0) * PI),
            )
            base.copy(
                gazeX = 0.0,
                gazeY = 0.0,
                bob = base.bob * 0.5 - nudge * 3,
                tilt = nudge * 6,
                eyeLeft = 1.1 * shut,
                eyeRight = 1.1 * shut,
                cheeks = 0.1,
                glow = 0.85 + nudge * 0.15,
                sparks = 0.3 + nudge * 0.7,
                sparkLength = 0.7 + nudge * 0.5,
            )
        }
        Mood.HAPPY -> {
            val bounce = abs(sin(t * TAU * 0.9))
            base.copy(
                gazeX = 0.0,
                gazeY = -0.1,
                bob = -bounce * 4,
                stretch = 1 + bounce * 0.025,
                tilt = sin(t * TAU * 0.45) * 5,
                eyeLeft = 1.0,
                eyeRight = 1.0,
                cheeks = 0.85,
                glow = 1.0,
                sparks = 0.5 + bounce * 0.5,
                sparkLength = 0.9 + bounce * 0.3,
            )
        }
        Mood.PUZZLED -> base.copy(
            gazeX = 0.5,
            gazeY = -0.35,
            tilt = 10 + sin(t * TAU * 0.3) * 2,
            eyeLeft = 1.15 * shut,
            eyeRight = 0.6 * shut,
            brows = 0.25,
            browSlant = 0.6,
            sparks = 0.2,
            sparkLength = 0.5,
        )
        Mood.SAD -> base.copy(
            bob = base.bob * 0.4 + 5,
            stretch = 0.975 + breath * 0.004,
            gazeX = -0.1,
            gazeY = 0.6,
            tilt = -4.0,
            eyeLeft = 0.8 * (1 - blink(t, 4.5)),
            eyeRight = 0.8 * (1 - blink(t, 4.5)),
            brows = 0.35,
            browSlant = 1.0,
            glow = 0.45,
            sway = base.sway * 0.4,
        )
        Mood.ASLEEP -> {
            val slow = sin((t * TAU) / 6)
            base.copy(
                bob = slow * 3 + 4,
                stretch = 1 + slow * 0.015,
                gazeX = 0.0,
                gazeY = 0.3,
                tilt = -7 + slow,
                eyeLeft = 0.07,
                eyeRight = 0.07,
                cheeks = 0.2,
                glow = 0.3,
                sway = slow * 0.4,
                dozing = 1.0,
            )
        }
    }
}

/** The pose between two, field by field; [k] 0 is [a], 1 is [b]. */
fun blend(a: Pose, b: Pose, k: Double): Pose = Pose(
    bob = mix(a.bob, b.bob, k),
    tilt = mix(a.tilt, b.tilt, k),
    stretch = mix(a.stretch, b.stretch, k),
    gazeX = mix(a.gazeX, b.gazeX, k),
    gazeY = mix(a.gazeY, b.gazeY, k),
    eyeLeft = mix(a.eyeLeft, b.eyeLeft, k),
    eyeRight = mix(a.eyeRight, b.eyeRight, k),
    cheeks = mix(a.cheeks, b.cheeks, k),
    brows = mix(a.brows, b.brows, k),
    browSlant = mix(a.browSlant, b.browSlant, k),
    glow = mix(a.glow, b.glow, k),
    // The shimmer sweeps rather than fades: it shows only where a pose has one.
    shimmer = if (k < 0.5) a.shimmer else b.shimmer,
    sparks = mix(a.sparks, b.sparks, k),
    sparkLength = mix(a.sparkLength, b.sparkLength, k),
    sway = mix(a.sway, b.sway, k),
    dozing = mix(a.dozing, b.dozing, k),
)

/** How far into a change of mood [elapsed] seconds is, eased; changes take 0.35 s. */
fun settle(elapsed: Double): Double = smooth(elapsed / 0.35)
