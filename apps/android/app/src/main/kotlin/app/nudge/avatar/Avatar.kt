package app.nudge.avatar

import android.animation.ValueAnimator
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import nudge.ffi.AnswerStatus
import nudge.ffi.Approval
import nudge.ffi.Live
import nudge.ffi.TimelineItem

/**
 * The Nudge robot, alive: it breathes and blinks, and shows [mood], easing from one mood to the
 * next. [level] is read every frame for the voice's loudness, 0 to 1, while listening or speaking.
 * Still when the phone's animations are off.
 */
@Composable
fun Avatar(
    mood: Mood,
    modifier: Modifier = Modifier,
    appearance: RobotLook = NUDGE,
    size: Dp = 96.dp,
    level: (() -> Double?)? = null,
    title: String? = null,
) {
    val robot = remember(appearance) { Robot(appearance) }
    val moving = remember { ValueAnimator.areAnimatorsEnabled() }
    // Seconds since it showed; read only while drawing, so a frame redraws without recomposing.
    var t by remember { mutableDoubleStateOf(START) }
    if (moving) {
        LaunchedEffect(Unit) {
            val start = withFrameNanos { it }
            while (true) withFrameNanos { t = START + (it - start) / 1e9 }
        }
    }
    val change = remember { Change(mood, mood, START) }
    Canvas(modifier.size(size).semantics { contentDescription = title ?: mood.name.lowercase() }) {
        val now = t
        if (change.to != mood) {
            // A change during a change starts from where the last one was going.
            change.from = change.to
            change.to = mood
            change.at = now
        }
        val voice = level?.invoke()
        val k = if (moving) settle(now - change.at) else 1.0
        val p = if (k >= 1) pose(change.to, now, voice) else blend(pose(change.from, now, voice), pose(change.to, now, voice), k)
        draw(robot, p, now)
    }
}

/** The robot at rest, for where many are drawn at once, such as beside every answer. */
@Composable
fun Portrait(modifier: Modifier = Modifier, appearance: RobotLook = NUDGE, size: Dp = 20.dp) {
    val robot = remember(appearance) { Robot(appearance) }
    Canvas(modifier.size(size)) { draw(robot, REST, 0.0) }
}

private const val START = 0.9

private class Change(var from: Mood, var to: Mood, var at: Double)

private fun DrawScope.draw(robot: Robot, pose: Pose, t: Double) = drawIntoCanvas { canvas ->
    val native = canvas.nativeCanvas
    native.save()
    native.scale(size.width / 200f, size.height / 200f)
    robot.draw(native, pose, t)
    native.restore()
}

/**
 * The robot's mood in a room, with a moment of joy or gloom when a turn ends while watching, as
 * the web app's useRoomMood.
 */
@Composable
fun roomMood(timeline: List<TimelineItem>, live: Live?, approvals: List<Approval>, listening: Boolean = false): Mood {
    // The time, again every minute: enough to notice the room going quiet.
    val now by produceState(System.currentTimeMillis().toDouble()) {
        while (true) {
            delay(60_000)
            value = System.currentTimeMillis().toDouble()
        }
    }
    val answer = timeline.lastAnswer()
    val seen = remember { Seen(answer?.id, answer?.status) }
    var afterglow by remember { mutableStateOf<Mood?>(null) }

    LaunchedEffect(answer?.id, answer?.status) {
        val beforeId = seen.id
        val beforeStatus = seen.status
        seen.id = answer?.id
        seen.status = answer?.status
        if (answer == null || beforeId != answer.id || beforeStatus != AnswerStatus.RUNNING) return@LaunchedEffect
        val mood = ended(answer.status) ?: return@LaunchedEffect
        afterglow = mood
        try {
            delay(AFTERGLOW.getValue(mood))
        } finally {
            afterglow = null
        }
    }

    val mood = moodOf(timeline, live, approvals, now, listening)
    return if (afterglow != null && mood == Mood.IDLE) afterglow!! else mood
}

private class Seen(var id: String?, var status: AnswerStatus?)
