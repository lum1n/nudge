// The robot's curves, as plain numbers on the 200 by 200 canvas, apart from how they are drawn:
// the same points as the web's `Avatar.tsx`.
import Foundation

typealias CanvasPoint = SIMD2<Double>

/// A curve of cubic Béziers from `start`: each segment is two control points and where it ends.
struct Curve: Equatable, Sendable {
    struct Segment: Equatable, Sendable {
        var control1: CanvasPoint
        var control2: CanvasPoint
        var end: CanvasPoint
    }

    var start: CanvasPoint
    var segments: [Segment]
    var closed: Bool

    /// A smooth curve through `points` (Catmull-Rom as cubic Béziers), closed unless `open`.
    init(smooth points: [CanvasPoint], open: Bool = false) {
        let n = points.count
        func at(_ i: Int) -> CanvasPoint { open ? points[min(n - 1, max(0, i))] : points[(i + n) % n] }
        start = at(0)
        segments = (0..<(open ? n - 1 : n)).map { i in
            let (p0, p1, p2, p3) = (at(i - 1), at(i), at(i + 1), at(i + 2))
            return Segment(control1: p1 + (p2 - p0) / 6, control2: p2 - (p3 - p1) / 6, end: p2)
        }
        closed = !open
    }
}

/// The ribbon the head sits in, after the app icon: a cup, round at both ends, with a lobe on the
/// left beside the head and an end under the right cheek. Its `back` reaches up behind the head;
/// its `front` comes up only to the `rim`, low under the chin, so the head sits in it, not behind
/// it. The ends sway a little.
struct Ribbon: Equatable, Sendable {
    var back: Curve
    var front: Curve
    var face: Curve
    var rim: Curve

    init(sway: Double) {
        let l = sway * 1.2
        let r = sway * 1.8
        let left = CanvasPoint(30 - l, 100)
        let right = CanvasPoint(163, 117 + r * 0.8)
        // Round the bottom from the left end to the right one.
        let bottom: [CanvasPoint] = [
            [16 - l, 106],
            [11 - l, 122],
            [16 - l * 0.5, 142],
            [30, 158],
            [54, 172],
            [82, 181],
            [104, 183],
            [128, 179 + r * 0.3],
            [150, 168 + r * 0.6],
            [164, 152 + r],
            [168, 134 + r],
        ]
        // The front's edge, from the left end to the right one: low under the chin.
        let edge: [CanvasPoint] = [
            [44, 114],
            [62, 128],
            [86, 138],
            [108, 141],
            [130, 137 + r * 0.3],
            [150, 128 + r * 0.6],
        ]
        // The far side, behind the head, from the right end to the left one.
        let far: [CanvasPoint] = [
            [158, 106 + r * 0.5],
            [130, 99],
            [98, 97],
            [64, 97],
            [42, 95],
        ]
        back = Curve(smooth: [left] + bottom + [right] + far)
        front = Curve(smooth: [left] + bottom + [right] + edge.reversed())
        // The face where the ribbon twists over on the left: from the rim down to the right end
        // and the bottom, and back up the twist.
        face = Curve(
            smooth: edge + [
                right,
                [170, 134 + r],
                [167, 154 + r],
                [152, 172 + r * 0.6],
                [128, 184 + r * 0.3],
                [100, 188],
                [76, 182],
                [60, 166],
                [48, 144],
                [38, 120],
            ])
        rim = Curve(smooth: [left] + edge + [right], open: true)
    }
}

/// An eye's size and corner on the canvas, and how far it is turned, in degrees.
struct EyeGeometry: Sendable {
    var width: Double
    var height: Double
    var radius: Double
    var turn: Double

    init(_ shape: EyeShape) {
        switch shape {
        case .pill: (width, height, radius, turn) = (12, 27, 6, 8)
        case .round: (width, height, radius, turn) = (19, 19, 9.5, 0)
        case .square: (width, height, radius, turn) = (17, 17, 4, 0)
        case .wide: (width, height, radius, turn) = (24, 12, 6, 0)
        }
    }
}
