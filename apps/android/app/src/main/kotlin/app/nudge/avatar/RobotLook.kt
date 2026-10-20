// How an assistant's robot looks: a few choices, not a picture, so it stays small, recolours on
// every platform, and everyone in a room sees the same one. As in the web app's appearance.ts.
package app.nudge.avatar

import kotlin.math.roundToInt

enum class EyeShape { PILL, ROUND, SQUARE, WIDE }

enum class Accessory { NONE, ANTENNA, HEADPHONES, SPROUT, CROWN }

data class RobotLook(
    /** The ribbon's two ends, as `#rrggbb`. */
    val body: Pair<String, String>,
    val eyes: String,
    val sparks: String,
    val eyeShape: EyeShape,
    val accessory: Accessory,
) {
    companion object
}

/** The robot of the app icon. */
val NUDGE = RobotLook(
    body = "#1438f5" to "#19e6f0",
    eyes = "#3ff6ff",
    sparks = "#2fe6b8",
    eyeShape = EyeShape.PILL,
    accessory = Accessory.NONE,
)

val PRESETS: Map<String, RobotLook> = linkedMapOf(
    "Nudge" to NUDGE,
    "Ember" to NUDGE.copy(body = "#e8361c" to "#ffb238", eyes = "#ffd36b", sparks = "#ff7a45"),
    "Moss" to NUDGE.copy(body = "#127a4a" to "#a5e86a", eyes = "#b8ff8a", sparks = "#e4f36a", eyeShape = EyeShape.ROUND),
    "Grape" to NUDGE.copy(body = "#5b21d6" to "#e45bff", eyes = "#f0a8ff", sparks = "#ff6fcf", eyeShape = EyeShape.WIDE),
    "Graphite" to NUDGE.copy(body = "#30343c" to "#8a94a6", eyes = "#ffffff", sparks = "#c9d1de", eyeShape = EyeShape.SQUARE),
)

/** [from] moved toward [to] by [k], both `#rrggbb`. */
fun tint(from: String, to: String, k: Double): String {
    fun channel(hex: String, i: Int) = hex.substring(1 + i * 2, 3 + i * 2).toInt(16)
    return "#" + (0..2).joinToString("") { i ->
        // Math.round in JavaScript rounds halves up, as roundToInt does.
        val mixed = (channel(from, i) + (channel(to, i) - channel(from, i)) * k).roundToInt()
        mixed.toString(16).padStart(2, '0')
    }
}

/** `#rrggbb` as an ARGB colour, with [alpha] 0 to 1. */
fun argb(hex: String, alpha: Double = 1.0): Int =
    ((alpha.coerceIn(0.0, 1.0) * 255).roundToInt() shl 24) or hex.substring(1, 7).toInt(16)
