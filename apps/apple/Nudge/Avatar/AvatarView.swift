// The Nudge robot drawn: a pose (Pose.swift) on a 200 by 200 canvas, as the web's `Avatar.tsx`
// draws it in SVG, shape for shape and in the same order.
import SwiftUI

/// The Nudge robot, alive: it breathes and blinks, and shows `mood`, easing from one mood to the
/// next. `level` is read every frame for the voice's loudness while listening or speaking.
struct AvatarView: View {
    let mood: Mood
    var appearance: Appearance = .nudge
    var size: CGFloat = 96
    var level: (@MainActor () -> Double)? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Its clock starts a little before it appears, as on the web.
    @State private var start = Date.now.addingTimeInterval(-0.9)
    @State private var change: Change?

    private struct Change {
        var from: Mood
        var at: Date
    }

    var body: some View {
        Group {
            if reduceMotion {
                // Still, for people who asked for less motion.
                RobotCanvas(pose: .of(mood, at: 0.9), t: 0.9, look: appearance)
            } else {
                TimelineView(.animation) { timeline in
                    let t = timeline.date.timeIntervalSince(start)
                    RobotCanvas(pose: pose(at: timeline.date, t: t), t: t, look: appearance)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .onChange(of: mood) { old, _ in
            // A change during a change starts from where the last one was going.
            change = Change(from: old, at: .now)
        }
    }

    private func pose(at date: Date, t: Double) -> Pose {
        let level = level?()
        let now = Pose.of(mood, at: t, level: level)
        guard let change else { return now }
        let k = Pose.settle(date.timeIntervalSince(change.at))
        return k >= 1 ? now : Pose.blend(.of(change.from, at: t, level: level), now, k)
    }
}

/// The robot at rest, for where many are drawn at once, such as beside every answer.
struct Portrait: View {
    var appearance: Appearance = .nudge
    var size: CGFloat = 20

    var body: some View {
        RobotCanvas(pose: .rest, t: 0, look: appearance)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// One pose, drawn.
struct RobotCanvas: View {
    let pose: Pose
    let t: Double
    let look: Appearance

    var body: some View {
        Canvas { context, size in
            Robot(p: pose, t: t, look: look, scale: min(size.width, size.height) / 200).draw(in: &context, size: size)
        }
    }
}

extension Color {
    /// A `#rrggbb` colour.
    init(hex: String, opacity: Double = 1) {
        let (r, g, b) = rgb(hex)
        self.init(.sRGB, red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255, opacity: opacity)
    }
}

@MainActor
private struct Robot {
    let p: Pose
    let t: Double
    let look: Appearance

    /// Points on the screen per unit of the canvas.
    let scale: CGFloat

    func draw(in context: inout GraphicsContext, size: CGSize) {
        context.translateBy(x: (size.width - 200 * scale) / 2, y: (size.height - 200 * scale) / 2)
        context.scaleBy(x: scale, y: scale)
        let (body0, body1) = look.body

        // The visor and eyes follow the gaze over the round head, a little narrower to the side.
        let vx = 104 + p.gazeX * 13
        let vy = 86 + p.gazeY * 9
        let vw = 86 * (1 - abs(p.gazeX) * 0.1)
        let vh = 64.0
        let visor = Path(
            roundedRect: CGRect(x: vx - vw / 2, y: vy - vh / 2, width: vw, height: vh),
            cornerSize: CGSize(width: 30, height: 32), style: .circular)

        let ribbon = Ribbon(sway: p.sway)
        let back = path(ribbon.back)
        let front = path(ribbon.front)
        let face = path(ribbon.face)
        let rim = path(ribbon.rim)
        let head = Path(ellipseIn: CGRect(x: 40, y: 26, width: 116, height: 116))
        let lift = max(0, -p.bob)

        var shadow = context
        shadow.opacity = max(0, 0.1 - lift * 0.01)
        let rx = 56 - lift * 2
        shadow.fill(Path(ellipseIn: CGRect(x: 100 - rx, y: 186, width: rx * 2, height: 10)), with: .color(Color(hex: "#0b1640")))

        // Squash and stretch from the bottom, keeping the volume.
        var robot = context
        robot.translateBy(x: 100, y: 100 + p.bob)
        robot.rotate(by: .degrees(p.tilt))
        robot.translateBy(x: -100, y: -100)
        robot.translateBy(x: 100, y: 176)
        robot.scaleBy(x: 1 / sqrt(p.stretch), y: p.stretch)
        robot.translateBy(x: -100, y: -176)

        if look.accessory == .headphones {
            robot.stroke(
                arc(cx: 98, cy: 90 + sqrt(63 * 63 - 62 * 62), radius: 63, from: 36, to: 160),
                with: .color(Color(hex: "#2a2f45")), style: StrokeStyle(lineWidth: 7, lineCap: .round))
        }
        // The ribbon is a cup the head sits in: its far side and inside are behind the head.
        robot.fill(
            back,
            with: .linearGradient(
                Gradient(colors: [
                    Color(hex: tint(tint(body0, body1, 0.3), "#000000", 0.25)), Color(hex: tint(body0, "#000000", 0.6)),
                ]),
                startPoint: CGPoint(x: 0, y: 96), endPoint: CGPoint(x: 0, y: 132)))
        fillBox(
            head, in: robot, box: head.boundingRect, center: CGPoint(x: 0.62, y: 0.28), radius: 0.85,
            gradient: Gradient(stops: [
                .init(color: Color(hex: "#ffffff"), location: 0),
                .init(color: Color(hex: "#f3f4ff"), location: 0.45),
                .init(color: Color(hex: "#c6ccf6"), location: 0.85),
                .init(color: Color(hex: "#a4b2f2"), location: 1),
            ]))
        // A soft shadow on the head where it sinks in.
        var sink = robot
        sink.translateBy(x: 0, y: -5)
        sink.clip(to: head)
        sink.opacity = 0.35
        blurred(sink, 2.5) {
            $0.stroke(rim, with: .color(Color(hex: tint(body0, "#000000", 0.5))), lineWidth: 14)
        }
        accessory(in: robot)

        var halo = robot
        halo.opacity = 0.35
        halo.fill(
            visor.applying(around(vx, vy, CGAffineTransform(scaleX: 1.07, y: 1.07))),
            with: .color(Color(hex: "#9fb4ff")))
        fillBox(
            visor, in: robot, box: visor.boundingRect, center: CGPoint(x: 0.45, y: 0.35), radius: 0.75,
            gradient: Gradient(colors: [Color(hex: "#141a30"), Color(hex: "#03050b")]))
        var inside = robot
        inside.clip(to: visor)
        if p.shimmer >= 0 {
            var shimmer = inside
            shimmer.concatenate(around(vx, vy, CGAffineTransform(rotationAngle: 18 * .pi / 180)))
            let x = vx - vw / 2 - 40 + p.shimmer * (vw + 40)
            shimmer.fill(
                Path(CGRect(x: x, y: vy - vh, width: 34, height: vh * 2)),
                with: .linearGradient(
                    Gradient(stops: [
                        .init(color: .white.opacity(0), location: 0),
                        .init(color: Color(hex: look.eyes, opacity: 0.28), location: 0.5),
                        .init(color: .white.opacity(0), location: 1),
                    ]),
                    startPoint: CGPoint(x: x, y: 0), endPoint: CGPoint(x: x + 34, y: 0)))
        }
        eyes(in: inside, vx: vx, vy: vy)
        robot.stroke(visor, with: .color(Color(hex: look.eyes, opacity: 0.18)), lineWidth: 1.2)

        // Its front comes up over the chin.
        robot.fill(
            front,
            with: .linearGradient(
                Gradient(stops: [
                    .init(color: Color(hex: body0), location: 0),
                    .init(color: Color(hex: body0), location: 0.4),
                    .init(color: Color(hex: body1), location: 1),
                ]),
                startPoint: CGPoint(x: 15, y: 120), endPoint: CGPoint(x: 165, y: 160)))
        // Its folds are shading inside it, soft, with no edges.
        var folds = robot
        folds.clip(to: front)
        let all = Path(CGRect(x: 0, y: 0, width: 200, height: 200))
        folds.fill(
            all,
            with: .radialGradient(
                Gradient(colors: [
                    Color(hex: tint(body0, "#000000", 0.3), opacity: 0.8), Color(hex: tint(body0, "#000000", 0.25), opacity: 0),
                ]),
                center: CGPoint(x: 34, y: 140), startRadius: 0, endRadius: 34))
        // The front face, where the ribbon twists over: lighter than the lobe behind it.
        blurred(folds, 2.5) {
            $0.fill(
                face,
                with: .linearGradient(
                    Gradient(colors: [Color(hex: tint(tint(body0, body1, 0.6), "#ffffff", 0.15)), Color(hex: body1)]),
                    startPoint: CGPoint(x: 40, y: 110), endPoint: CGPoint(x: 160, y: 170)))
        }
        folds.fill(
            all,
            with: .radialGradient(
                Gradient(colors: [.white.opacity(0.4), .white.opacity(0)]),
                center: CGPoint(x: 146, y: 146), startRadius: 0, endRadius: 22))
        folds.fill(
            all,
            with: .radialGradient(
                Gradient(colors: [.white.opacity(0.35), .white.opacity(0)]),
                center: CGPoint(x: 28, y: 108), startRadius: 0, endRadius: 18))
        robot.stroke(
            rim,
            with: .linearGradient(
                Gradient(stops: [
                    .init(color: .white.opacity(0), location: 0),
                    .init(color: .white.opacity(0.45), location: 0.3),
                    .init(color: .white.opacity(0.45), location: 0.8),
                    .init(color: .white.opacity(0), location: 1),
                ]),
                startPoint: CGPoint(x: 38, y: 0), endPoint: CGPoint(x: 160, y: 0)),
            style: StrokeStyle(lineWidth: 1.5, lineCap: .round))

        if p.sparks > 0.01 {
            var sparks = robot
            sparks.opacity = p.sparks
            spark(in: sparks, x: 150, y: 40, dx: 13, dy: -22)
            spark(in: sparks, x: 162, y: 62, dx: 22, dy: -12)
        }

        if p.dozing > 0.01 {
            for n in 0..<3 {
                let phase = (t / 3 + Double(n) / 3).truncatingRemainder(dividingBy: 1)
                var z = context
                z.opacity = max(0, p.dozing * sin(phase * .pi) * 0.9)
                let text = z.resolve(
                    Text("z")
                        .font(.system(size: 11 + phase * 9, weight: .bold))
                        .foregroundStyle(Color(hex: tint(body0, body1, 0.5))))
                let size = text.measure(in: CGSize(width: 200, height: 200))
                // Placed by its baseline, as SVG text is.
                let baseline = text.firstBaseline(in: size)
                z.draw(
                    text,
                    in: CGRect(
                        x: 150 + phase * 18 + Double(n) * 4, y: 60 - phase * 44 - baseline, width: size.width,
                        height: size.height))
            }
        }
    }

    /// Both eyes, cut by their lids: cheeks push up from below and leave a crescent, a smile;
    /// brows come down from above, slanted.
    private func eyes(in context: GraphicsContext, vx: Double, vy: Double) {
        let shape = EyeGeometry(look.eyeShape)
        let color = Color(hex: look.eyes)
        for (x, open, side) in [(vx - 17 + p.gazeX * 5, p.eyeLeft, -1.0), (vx + 17 + p.gazeX * 5, p.eyeRight, 1.0)] {
            let y = vy + p.gazeY * 7
            let h = max(1.6, shape.height * open)
            var eye = context
            eye.concatenate(around(x, y, CGAffineTransform(rotationAngle: shape.turn * .pi / 180)))
            let box = CGRect(x: x - shape.width / 2, y: y - h / 2, width: shape.width, height: h)
            let rect = Path(roundedRect: box, cornerRadius: min(shape.radius, h / 2))
            let cheek = Path(
                ellipseIn: CGRect(
                    center: CGPoint(
                        x: x, y: y + h / 2 + shape.height * 0.5 + 6 - p.cheeks * (h * 0.62 + 2)),
                    radii: CGSize(width: shape.width * 0.8, height: shape.height * 0.5 + 4)))
            let brow = Path(
                CGRect(x: x - shape.width * 1.5, y: y - h / 2 - 32 + p.brows * h * 0.9, width: shape.width * 3, height: 30)
            )
            .applying(around(x, y, CGAffineTransform(rotationAngle: side * p.browSlant * 20 * .pi / 180)))
            func lidded(_ context: GraphicsContext, _ content: (inout GraphicsContext) -> Void) {
                context.drawLayer { layer in
                    content(&layer)
                    layer.blendMode = .destinationOut
                    layer.fill(cheek, with: .color(.black))
                    layer.fill(brow, with: .color(.black))
                }
            }

            var glow = eye
            glow.opacity = p.glow
            blurred(glow, 4) { layer in
                lidded(layer) { $0.fill(rect, with: .color(color)) }
            }
            lidded(eye) { layer in
                var lit = layer
                lit.opacity = 0.55 + p.glow * 0.45
                lit.fill(rect, with: .color(color))
                layer.fill(
                    rect,
                    with: .linearGradient(
                        Gradient(stops: [
                            .init(color: .white.opacity(0.55), location: 0),
                            .init(color: color.opacity(0), location: 0.35),
                        ]),
                        startPoint: CGPoint(x: box.minX, y: box.minY), endPoint: CGPoint(x: box.minX, y: box.maxY)))
            }
        }
    }

    /// A spark that grows out from where it starts.
    private func spark(in context: GraphicsContext, x: Double, y: Double, dx: Double, dy: Double) {
        let length = p.sparkLength
        // It starts a little away from the head and reaches out.
        let gap = (1 - min(1, length)) * 0.4
        let from = CGPoint(x: x + dx * gap, y: y + dy * gap)
        let to = CGPoint(x: x + dx * length, y: y + dy * length)
        var line = Path()
        line.move(to: from)
        line.addLine(to: to)
        context.stroke(
            line,
            with: .linearGradient(
                Gradient(colors: [Color(hex: look.sparks), Color(hex: look.sparks, opacity: 0.75)]),
                startPoint: from, endPoint: to),
            style: StrokeStyle(lineWidth: 9, lineCap: .round))
    }

    private func accessory(in context: GraphicsContext) {
        switch look.accessory {
        case .none:
            break
        case .antenna:
            var stalk = Path()
            stalk.move(to: CGPoint(x: 96, y: 27))
            stalk.addQuadCurve(to: CGPoint(x: 100, y: 6), control: CGPoint(x: 92, y: 14))
            context.stroke(stalk, with: .color(Color(hex: "#a4b2f2")), style: StrokeStyle(lineWidth: 4, lineCap: .round))
            var glow = context
            glow.opacity = p.glow
            blurred(glow, 4) {
                $0.fill(Path(ellipseIn: CGRect(x: 93, y: -1, width: 14, height: 14)), with: .color(Color(hex: look.sparks)))
            }
            context.fill(Path(ellipseIn: CGRect(x: 94.5, y: 0.5, width: 11, height: 11)), with: .color(Color(hex: look.sparks)))
        case .headphones:
            for x in [28.0, 151] {
                let box = CGRect(x: x, y: 70, width: 17, height: 36)
                context.fill(
                    Path(roundedRect: box, cornerRadius: 8.5),
                    with: .linearGradient(
                        Gradient(colors: [Color(hex: look.body.0), Color(hex: look.body.1)]),
                        startPoint: CGPoint(x: box.minX, y: box.minY), endPoint: CGPoint(x: box.maxX, y: box.maxY)))
            }
        case .sprout:
            var stem = Path()
            stem.move(to: CGPoint(x: 98, y: 27))
            stem.addQuadCurve(to: CGPoint(x: 100, y: 10), control: CGPoint(x: 97, y: 16))
            context.stroke(stem, with: .color(Color(hex: "#3aa65a")), style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
            var left = Path()
            left.move(to: CGPoint(x: 100, y: 12))
            left.addCurve(to: CGPoint(x: 78, y: 12), control1: CGPoint(x: 92, y: 2), control2: CGPoint(x: 80, y: 4))
            left.addCurve(to: CGPoint(x: 100, y: 12), control1: CGPoint(x: 86, y: 16), control2: CGPoint(x: 95, y: 16))
            left.closeSubpath()
            context.fill(left, with: .color(Color(hex: "#5cd36e")))
            var right = Path()
            right.move(to: CGPoint(x: 100, y: 12))
            right.addCurve(to: CGPoint(x: 122, y: 8), control1: CGPoint(x: 106, y: 0), control2: CGPoint(x: 120, y: 0))
            right.addCurve(to: CGPoint(x: 100, y: 12), control1: CGPoint(x: 114, y: 14), control2: CGPoint(x: 105, y: 15))
            right.closeSubpath()
            context.fill(right, with: .color(Color(hex: "#7be27f")))
        case .crown:
            var crown = Path()
            crown.move(to: CGPoint(x: 76, y: 33))
            for (x, y) in [(72.0, 12.0), (86, 22), (98, 6), (110, 22), (124, 12), (120, 33)] {
                crown.addLine(to: CGPoint(x: x, y: y))
            }
            crown.addQuadCurve(to: CGPoint(x: 76, y: 33), control: CGPoint(x: 98, y: 27))
            crown.closeSubpath()
            context.fill(crown, with: .color(Color(hex: "#ffc83d")))
            context.stroke(crown, with: .color(Color(hex: "#e8a317")), style: StrokeStyle(lineWidth: 2, lineJoin: .round))
        }
    }

    /// Draws `content` blurred by `deviation` units of the canvas, as SVG's feGaussianBlur.
    private func blurred(_ context: GraphicsContext, _ deviation: Double, _ content: (inout GraphicsContext) -> Void) {
        let transform = context.transform
        context.drawLayer { layer in
            // The radius in points on the screen, whatever the layer's transform does to it.
            layer.transform = .identity
            layer.addFilter(.blur(radius: deviation * scale))
            layer.transform = transform
            // The context's opacity applies once, to the layer as a whole.
            layer.opacity = 1
            content(&layer)
        }
    }

    /// Fills `shape` with a radial gradient set out in its box, from 0 to 1 on each side, as SVG's
    /// gradients in `objectBoundingBox` units are: an ellipse in a box that isn't square.
    private func fillBox(
        _ shape: Path, in context: GraphicsContext, box: CGRect, center: CGPoint, radius: Double, gradient: Gradient
    ) {
        var inBox = context
        inBox.clip(to: shape)
        inBox.translateBy(x: box.minX, y: box.minY)
        inBox.scaleBy(x: box.width, y: box.height)
        inBox.fill(
            Path(CGRect(x: 0, y: 0, width: 1, height: 1)),
            with: .radialGradient(gradient, center: center, startRadius: 0, endRadius: radius))
    }

    private func path(_ curve: Curve) -> Path {
        var path = Path()
        path.move(to: point(curve.start))
        for segment in curve.segments {
            path.addCurve(to: point(segment.end), control1: point(segment.control1), control2: point(segment.control2))
        }
        if curve.closed { path.closeSubpath() }
        return path
    }

    private func point(_ p: CanvasPoint) -> CGPoint { CGPoint(x: p.x, y: p.y) }

    /// The top of a circle, from where its upper half is at `from` on the left to `to` on the right:
    /// SVG's `A` from one to the other, sweeping over.
    private func arc(cx: Double, cy: Double, radius: Double, from: Double, to: Double) -> Path {
        let start = atan2(-sqrt(radius * radius - (from - cx) * (from - cx)), from - cx)
        let end = atan2(-sqrt(radius * radius - (to - cx) * (to - cx)), to - cx)
        var path = Path()
        for step in 0...32 {
            let angle = start + (end - start) * Double(step) / 32
            let point = CGPoint(x: cx + radius * cos(angle), y: cy + radius * sin(angle))
            if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        return path
    }

    /// `transform` about the point at `x`, `y`.
    private func around(_ x: Double, _ y: Double, _ transform: CGAffineTransform) -> CGAffineTransform {
        CGAffineTransform(translationX: -x, y: -y).concatenating(transform).concatenating(
            CGAffineTransform(translationX: x, y: y))
    }
}

extension CGRect {
    fileprivate init(center: CGPoint, radii: CGSize) {
        self.init(x: center.x - radii.width, y: center.y - radii.height, width: radii.width * 2, height: radii.height * 2)
    }
}
