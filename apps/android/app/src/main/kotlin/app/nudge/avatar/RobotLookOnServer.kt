package app.nudge.avatar

import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.Session
import nudge.ffi.Appearance

/**
 * What the server says, as this app draws it: the app icon's robot for none, and its eyes or
 * nothing worn for a choice made by a newer app.
 */
fun RobotLook.Companion.of(appearance: Appearance?): RobotLook {
    if (appearance == null || appearance.body.size != 2) return NUDGE
    return RobotLook(
        body = appearance.body[0] to appearance.body[1],
        eyes = appearance.eyes,
        sparks = appearance.sparks,
        eyeShape = EyeShape.entries.firstOrNull { it.name.equals(appearance.eyeShape, ignoreCase = true) } ?: NUDGE.eyeShape,
        accessory = Accessory.entries.firstOrNull { it.name.equals(appearance.accessory, ignoreCase = true) } ?: Accessory.NONE,
    )
}

/** As the server keeps it. */
fun RobotLook.toAppearance() = Appearance(
    body = listOf(body.first, body.second),
    eyes = eyes,
    sparks = sparks,
    eyeShape = eyeShape.name.lowercase(),
    accessory = accessory.name.lowercase(),
)

/** How the assistant's robot looks, from its room list; the app icon's until that arrives. */
@Composable
fun Session.look(): RobotLook {
    val list by roomList.state.collectAsStateWithLifecycle()
    return RobotLook.of(list?.view?.appearance)
}

/** The robot of the assistant whose room this is, for the portraits beside its answers. */
val LocalRobotLook = compositionLocalOf { NUDGE }
