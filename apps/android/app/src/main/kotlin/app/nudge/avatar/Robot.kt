// The robot drawn from a pose, on a 200 by 200 canvas, as the web app's Avatar.tsx draws it: the
// same shapes, gradients and order. On the platform canvas, for blurs that work on every Android
// version the app runs on (Compose's blur needs Android 12).
package app.nudge.avatar

import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

private class Eye(val w: Float, val h: Float, val r: Float, val turn: Float)

private fun eyeOf(shape: EyeShape) = when (shape) {
    EyeShape.PILL -> Eye(12f, 27f, 6f, 8f)
    EyeShape.ROUND -> Eye(19f, 19f, 9.5f, 0f)
    EyeShape.SQUARE -> Eye(17f, 17f, 4f, 0f)
    EyeShape.WIDE -> Eye(24f, 12f, 6f, 0f)
}

/** A blur of SVG's `stdDeviation` [sigma]; Android takes a radius, sigma = 0.57735 radius + 0.5. */
private fun blur(sigma: Float) = BlurMaskFilter((sigma - 0.5f) / 0.57735f, BlurMaskFilter.Blur.NORMAL)

// Blurs on paths need the drawing pipeline of Android 9 and later; before, they draw sharp.
private val blurs = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P

/** A shader given in the units of [box] (SVG's objectBoundingBox), stretched over it. */
private fun Shader.over(box: RectF): Shader = apply {
    setLocalMatrix(Matrix().apply {
        setScale(box.width(), box.height())
        postTranslate(box.left, box.top)
    })
}

private fun linear(x1: Float, y1: Float, x2: Float, y2: Float, vararg stops: Pair<Float, Int>) =
    LinearGradient(x1, y1, x2, y2, stops.map { it.second }.toIntArray(), stops.map { it.first }.toFloatArray(), Shader.TileMode.CLAMP)

private fun radial(cx: Float, cy: Float, r: Float, vararg stops: Pair<Float, Int>) =
    RadialGradient(cx, cy, r, stops.map { it.second }.toIntArray(), stops.map { it.first }.toFloatArray(), Shader.TileMode.CLAMP)

// A paint with a shader takes its alpha from the paint too.
private const val OPAQUE = -0x1000000

private typealias Point = Pair<Float, Float>

/** A smooth curve through [points] (Catmull-Rom as cubic Béziers), closed unless [open]. */
private fun smooth(points: List<Point>, open: Boolean = false): Path {
    val n = points.size
    fun at(i: Int) = if (open) points[min(n - 1, max(0, i))] else points[((i % n) + n) % n]
    val path = Path()
    path.moveTo(at(0).first, at(0).second)
    for (i in 0 until if (open) n - 1 else n) {
        val p0 = at(i - 1)
        val p1 = at(i)
        val p2 = at(i + 1)
        val p3 = at(i + 2)
        path.cubicTo(
            p1.first + (p2.first - p0.first) / 6, p1.second + (p2.second - p0.second) / 6,
            p2.first - (p3.first - p1.first) / 6, p2.second - (p3.second - p1.second) / 6,
            p2.first, p2.second,
        )
    }
    if (!open) path.close()
    return path
}

private class Ribbon(val back: Path, val front: Path, val face: Path, val rim: Path)

/**
 * The ribbon the head sits in, after the app icon: a cup, round at both ends, with a lobe on the
 * left beside the head and an end under the right cheek. Its `back` reaches up behind the head;
 * its `front` comes up only to the `rim`, low under the chin, so the head sits in it, not behind
 * it. The ends sway a little.
 */
private fun ribbon(sway: Float): Ribbon {
    val l = sway * 1.2f
    val r = sway * 1.8f
    val left: Point = 30 - l to 100f
    val right: Point = 163f to 117 + r * 0.8f
    // Round the bottom from the left end to the right one.
    val bottom = listOf(
        16 - l to 106f,
        11 - l to 122f,
        16 - l * 0.5f to 142f,
        30f to 158f,
        54f to 172f,
        82f to 181f,
        104f to 183f,
        128f to 179 + r * 0.3f,
        150f to 168 + r * 0.6f,
        164f to 152 + r,
        168f to 134 + r,
    )
    // The front's edge, from the left end to the right one: low under the chin.
    val edge = listOf(
        44f to 114f,
        62f to 128f,
        86f to 138f,
        108f to 141f,
        130f to 137 + r * 0.3f,
        150f to 128 + r * 0.6f,
    )
    // The far side, behind the head, from the right end to the left one.
    val far = listOf(
        158f to 106 + r * 0.5f,
        130f to 99f,
        98f to 97f,
        64f to 97f,
        42f to 95f,
    )
    val back = smooth(listOf(left) + bottom + right + far)
    val front = smooth(listOf(left) + bottom + right + edge.reversed())
    // The face where the ribbon twists over on the left: from the rim down to the right end and
    // the bottom, and back up the twist.
    val face = smooth(
        edge + listOf(
            right,
            170f to 134 + r,
            167f to 154 + r,
            152f to 172 + r * 0.6f,
            128f to 184 + r * 0.3f,
            100f to 188f,
            76f to 182f,
            60f to 166f,
            48f to 144f,
            38f to 120f,
        ),
    )
    return Ribbon(back, front, face, smooth(listOf(left) + edge + right, open = true))
}

/** A circle's arc from one point to another, clockwise, the short way: SVG's `A r r 0 0 1`. */
private fun Path.arcClockwise(x0: Float, y0: Float, x1: Float, y1: Float, radius: Float) {
    val mx = (x0 + x1) / 2
    val my = (y0 + y1) / 2
    val dx = x1 - x0
    val dy = y1 - y0
    val chord = sqrt(dx * dx + dy * dy)
    val away = sqrt(max(0f, radius * radius - chord * chord / 4))
    // The centre is to the right of the way from start to end, for the short way round clockwise.
    val cx = mx - dy / chord * away
    val cy = my + dx / chord * away
    val start = Math.toDegrees(atan2((y0 - cy).toDouble(), (x0 - cx).toDouble())).toFloat()
    var end = Math.toDegrees(atan2((y1 - cy).toDouble(), (x1 - cx).toDouble())).toFloat()
    if (end < start) end += 360f
    moveTo(x0, y0)
    arcTo(RectF(cx - radius, cy - radius, cx + radius, cy + radius), start, end - start)
}

/** Draws one look's robot; keeps what doesn't change from frame to frame. */
class Robot(private val look: RobotLook) {
    private val body0 = look.body.first
    private val body1 = look.body.second
    private val eye = eyeOf(look.eyeShape)

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val soft = if (blurs) blur(2.5f) else null
    private val glowBlur = if (blurs) blur(4f) else null

    private val headBox = RectF(40f, 26f, 156f, 142f)
    private val head = Path().apply { addCircle(98f, 84f, 58f, Path.Direction.CW) }
    private val headShader = radial(
        0.62f, 0.28f, 0.85f,
        0f to argb("#ffffff"), 0.45f to argb("#f3f4ff"), 0.85f to argb("#c6ccf6"), 1f to argb("#a4b2f2"),
    ).over(headBox)
    // The ribbon is one piece; its folds are shading inside it, soft, with no edges.
    private val ribbonShader = linear(15f, 120f, 165f, 160f, 0f to argb(body0), 0.4f to argb(body0), 1f to argb(body1))
    // The front face, where the ribbon twists over: lighter than the lobe behind it.
    private val faceShader = linear(40f, 110f, 160f, 170f, 0f to argb(tint(tint(body0, body1, 0.6), "#ffffff", 0.15)), 1f to argb(body1))
    private val depthShader = radial(34f, 140f, 34f, 0f to argb(tint(body0, "#000000", 0.3), 0.8), 1f to argb(tint(body0, "#000000", 0.25), 0.0))
    private val insideShader = linear(0f, 96f, 0f, 132f, 0f to argb(tint(tint(body0, body1, 0.3), "#000000", 0.25)), 1f to argb(tint(body0, "#000000", 0.6)))
    private val foldShader = linear(
        38f, 0f, 160f, 0f,
        0f to argb("#ffffff", 0.0), 0.3f to argb("#ffffff", 0.45), 0.8f to argb("#ffffff", 0.45), 1f to argb("#ffffff", 0.0),
    )
    private val sheenShader = radial(146f, 146f, 22f, 0f to argb("#ffffff", 0.4), 1f to argb("#ffffff", 0.0))
    private val liftShader = radial(28f, 108f, 18f, 0f to argb("#ffffff", 0.35), 1f to argb("#ffffff", 0.0))
    private val shadow = argb(tint(body0, "#000000", 0.5), 0.35)
    private val dozeColor = tint(body0, body1, 0.5)
    private val bold = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)

    /** Draws [p] at [t] seconds (for the "z"s) on [canvas], already scaled to 200 by 200. */
    fun draw(canvas: Canvas, p: Pose, t: Double) {
        val gazeX = p.gazeX.toFloat()
        val gazeY = p.gazeY.toFloat()
        // The visor and eyes follow the gaze over the round head, a little narrower to the side.
        val vx = 104 + gazeX * 13
        val vy = 86 + gazeY * 9
        val vw = 86 * (1 - abs(gazeX) * 0.1f)
        val vh = 64f
        // Straight top and bottom, rounded ends of 30 by 32: the web's path of two arcs.
        val visorBox = RectF(vx - vw / 2, vy - vh / 2, vx + vw / 2, vy + vh / 2)
        val visor = Path().apply { addRoundRect(visorBox, 30f, 32f, Path.Direction.CW) }
        val ribbon = ribbon(p.sway.toFloat())
        val lift = max(0.0, -p.bob).toFloat()

        fillWith(argb("#0b1640", 0.1 - lift * 0.01))
        canvas.drawOval(100 - (56 - lift * 2), 186f, 100 + (56 - lift * 2), 196f, fill)

        canvas.save()
        // Squash and stretch from the bottom, keeping the volume.
        canvas.translate(100f, 100 + p.bob.toFloat())
        canvas.rotate(p.tilt.toFloat())
        canvas.translate(-100f, -100f)
        canvas.translate(100f, 176f)
        canvas.scale((1 / sqrt(p.stretch)).toFloat(), p.stretch.toFloat())
        canvas.translate(-100f, -176f)

        if (look.accessory == Accessory.HEADPHONES) {
            strokeWith(7f, argb("#2a2f45"), Paint.Cap.ROUND)
            canvas.drawPath(Path().apply { arcClockwise(36f, 90f, 160f, 90f, 63f) }, stroke)
        }
        // The ribbon is a cup the head sits in: its far side and inside are behind the head.
        fillWith(insideShader)
        canvas.drawPath(ribbon.back, fill)
        fillWith(headShader)
        canvas.drawPath(head, fill)
        // A soft shadow on the head where it sinks in.
        canvas.save()
        canvas.translate(0f, -5f)
        canvas.clipPath(head)
        strokeWith(14f, shadow)
        stroke.maskFilter = soft
        canvas.drawPath(ribbon.rim, stroke)
        canvas.restore()
        accessory(canvas, p.glow.toFloat())

        canvas.save()
        canvas.scale(1.07f, 1.07f, vx, vy)
        fillWith(argb("#9fb4ff", 0.35))
        canvas.drawPath(visor, fill)
        canvas.restore()
        fillWith(radial(0.45f, 0.35f, 0.75f, 0f to argb("#141a30"), 1f to argb("#03050b")).over(visorBox))
        canvas.drawPath(visor, fill)

        canvas.save()
        canvas.clipPath(visor)
        if (p.shimmer >= 0) {
            val x = vx - vw / 2 - 40 + p.shimmer.toFloat() * (vw + 40)
            val box = RectF(x, vy - vh, x + 34, vy + vh)
            canvas.save()
            canvas.rotate(18f, vx, vy)
            fillWith(linear(0f, 0f, 1f, 0f, 0f to argb("#ffffff", 0.0), 0.5f to argb(look.eyes, 0.28), 1f to argb("#ffffff", 0.0)).over(box))
            canvas.drawRect(box, fill)
            canvas.restore()
        }
        eye(canvas, p, vx - 17 + gazeX * 5, vy + gazeY * 7, p.eyeLeft.toFloat(), -1)
        eye(canvas, p, vx + 17 + gazeX * 5, vy + gazeY * 7, p.eyeRight.toFloat(), 1)
        canvas.restore()
        strokeWith(1.2f, argb(look.eyes, 0.18))
        canvas.drawPath(visor, stroke)

        // Its front comes up over the chin.
        fillWith(ribbonShader)
        canvas.drawPath(ribbon.front, fill)
        canvas.save()
        canvas.clipPath(ribbon.front)
        fillWith(depthShader)
        canvas.drawRect(0f, 0f, 200f, 200f, fill)
        fillWith(faceShader)
        fill.maskFilter = soft
        canvas.drawPath(ribbon.face, fill)
        fillWith(sheenShader)
        canvas.drawRect(0f, 0f, 200f, 200f, fill)
        fillWith(liftShader)
        canvas.drawRect(0f, 0f, 200f, 200f, fill)
        canvas.restore()
        strokeWith(1.5f, OPAQUE, Paint.Cap.ROUND)
        stroke.shader = foldShader
        canvas.drawPath(ribbon.rim, stroke)

        if (p.sparks > 0.01) {
            spark(canvas, 150f, 40f, 13f, -22f, p.sparkLength.toFloat(), p.sparks.toFloat())
            spark(canvas, 162f, 62f, 22f, -12f, p.sparkLength.toFloat(), p.sparks.toFloat())
        }
        canvas.restore()

        if (p.dozing > 0.01) {
            for (n in 0..2) {
                val phase = (t / 3 + n / 3.0) % 1
                fillWith(argb(dozeColor, p.dozing * sin(phase * PI) * 0.9))
                fill.typeface = bold
                fill.textSize = (11 + phase * 9).toFloat()
                canvas.drawText("z", (150 + phase * 18 + n * 4).toFloat(), (60 - phase * 44).toFloat(), fill)
            }
        }
    }

    private fun fillWith(color: Int) {
        fill.reset()
        fill.isAntiAlias = true
        fill.color = color
    }

    private fun fillWith(shader: Shader) {
        fillWith(OPAQUE)
        fill.shader = shader
    }

    private fun strokeWith(width: Float, color: Int, cap: Paint.Cap = Paint.Cap.BUTT) {
        stroke.reset()
        stroke.isAntiAlias = true
        stroke.style = Paint.Style.STROKE
        stroke.strokeWidth = width
        stroke.strokeCap = cap
        stroke.color = color
    }

    private fun eye(canvas: Canvas, p: Pose, x: Float, y: Float, open: Float, side: Int) {
        val h = max(1.6f, eye.h * open)
        val box = RectF(x - eye.w / 2, y - h / 2, x + eye.w / 2, y + h / 2)
        val radius = min(eye.r, h / 2)
        // The lids cut the eye: cheeks push up from below and leave a crescent, a smile; brows
        // come down from above, slanted.
        val cheeks = p.cheeks.toFloat()
        val cy = y + h / 2 + eye.h * 0.5f + 6 - cheeks * (h * 0.62f + 2)
        val cheek = Path().apply {
            addOval(RectF(x - eye.w * 0.8f, cy - (eye.h * 0.5f + 4), x + eye.w * 0.8f, cy + (eye.h * 0.5f + 4)), Path.Direction.CW)
        }
        val top = y - h / 2 - 32 + p.brows.toFloat() * h * 0.9f
        val brow = Path().apply {
            addRect(x - eye.w * 1.5f, top, x + eye.w * 1.5f, top + 30, Path.Direction.CW)
            transform(Matrix().apply { setRotate(side * p.browSlant.toFloat() * 20, x, y) })
        }
        val shape = Path().apply {
            addRoundRect(box, radius, radius, Path.Direction.CW)
            op(cheek, Path.Op.DIFFERENCE)
            op(brow, Path.Op.DIFFERENCE)
        }

        canvas.save()
        canvas.rotate(eye.turn, x, y)
        val glow = p.glow.coerceIn(0.0, 1.0)
        fillWith(argb(look.eyes, glow))
        fill.maskFilter = glowBlur
        canvas.drawPath(shape, fill)
        fillWith(argb(look.eyes, 0.55 + glow * 0.45))
        canvas.drawPath(shape, fill)
        fillWith(linear(0f, 0f, 0f, 1f, 0f to argb("#ffffff", 0.55), 0.35f to argb(look.eyes, 0.0)).over(box))
        canvas.drawPath(shape, fill)
        canvas.restore()
    }

    /** A spark that grows out from where it starts. */
    private fun spark(canvas: Canvas, x: Float, y: Float, dx: Float, dy: Float, length: Float, opacity: Float) {
        // It starts a little away from the head and reaches out.
        val gap = (1 - min(1f, length)) * 0.4f
        val x1 = x + dx * gap
        val y1 = y + dy * gap
        val x2 = x + dx * length
        val y2 = y + dy * length
        val box = RectF(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))
        strokeWith(9f, OPAQUE, Paint.Cap.ROUND)
        stroke.shader = linear(0f, 1f, 1f, 0f, 0f to argb(look.sparks, opacity.toDouble()), 1f to argb(look.sparks, opacity * 0.75)).over(box)
        canvas.drawLine(x1, y1, x2, y2, stroke)
    }

    private fun accessory(canvas: Canvas, glow: Float) {
        when (look.accessory) {
            Accessory.NONE -> {}
            Accessory.ANTENNA -> {
                strokeWith(4f, argb("#a4b2f2"), Paint.Cap.ROUND)
                canvas.drawPath(Path().apply { moveTo(96f, 27f); quadTo(92f, 14f, 100f, 6f) }, stroke)
                fillWith(argb(look.sparks, glow.toDouble()))
                fill.maskFilter = glowBlur
                canvas.drawCircle(100f, 6f, 7f, fill)
                fillWith(argb(look.sparks))
                canvas.drawCircle(100f, 6f, 5.5f, fill)
            }
            Accessory.HEADPHONES -> for (x in listOf(28f, 151f)) {
                val box = RectF(x, 70f, x + 17, 106f)
                fillWith(linear(0f, 0f, 1f, 1f, 0f to argb(body0), 1f to argb(body1)).over(box))
                canvas.drawRoundRect(box, 8.5f, 8.5f, fill)
            }
            Accessory.SPROUT -> {
                strokeWith(3.5f, argb("#3aa65a"), Paint.Cap.ROUND)
                canvas.drawPath(Path().apply { moveTo(98f, 27f); quadTo(97f, 16f, 100f, 10f) }, stroke)
                fillWith(argb("#5cd36e"))
                canvas.drawPath(Path().apply {
                    moveTo(100f, 12f); cubicTo(92f, 2f, 80f, 4f, 78f, 12f); cubicTo(86f, 16f, 95f, 16f, 100f, 12f); close()
                }, fill)
                fillWith(argb("#7be27f"))
                canvas.drawPath(Path().apply {
                    moveTo(100f, 12f); cubicTo(106f, 0f, 120f, 0f, 122f, 8f); cubicTo(114f, 14f, 105f, 15f, 100f, 12f); close()
                }, fill)
            }
            Accessory.CROWN -> {
                val crown = Path().apply {
                    moveTo(76f, 33f); lineTo(72f, 12f); lineTo(86f, 22f); lineTo(98f, 6f); lineTo(110f, 22f)
                    lineTo(124f, 12f); lineTo(120f, 33f); quadTo(98f, 27f, 76f, 33f); close()
                }
                fillWith(argb("#ffc83d"))
                canvas.drawPath(crown, fill)
                strokeWith(2f, argb("#e8a317"))
                stroke.strokeJoin = Paint.Join.ROUND
                canvas.drawPath(crown, stroke)
            }
        }
    }
}
