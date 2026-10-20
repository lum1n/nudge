// The Nudge robot's motion, apart from how it is drawn: what it feels and the time give a pose of
// plain numbers. A port of the web's `apps/web/src/avatar/pose.ts`, number for number, so the
// robot moves the same everywhere; nothing here is random, the same moment always gives the same
// pose.
import Foundation

/// What the robot is doing, from what the room is doing.
enum Mood: String, CaseIterable, Sendable {
    /// Nothing going on: breathes, blinks, looks around.
    case idle
    /// Someone is dictating: eyes wide, following the voice.
    case listening
    /// A turn is running: looks up, the visor shimmers.
    case thinking
    /// The answer is coming: eyes bounce with it.
    case speaking
    /// A tool is running: looks down at its work.
    case working
    /// An approval waits for someone: nudges, the sparks flash.
    case waiting
    /// A turn just ended well.
    case happy
    /// Retrying after an error.
    case puzzled
    /// A turn failed.
    case sad
    /// Nothing for a long while.
    case asleep
}

struct Pose: Equatable, Sendable {
    /// Up and down, in units of the 200-wide canvas; up is negative.
    var bob: Double
    /// Head tilt in degrees, clockwise.
    var tilt: Double
    /// Squash and stretch of the whole robot: 1 is at rest, more is taller.
    var stretch: Double
    /// Where it looks, -1 to 1 (right and down are positive).
    var gazeX: Double
    var gazeY: Double
    /// How open each eye is, 0 to about 1.3.
    var eyeLeft: Double
    var eyeRight: Double
    /// How far the cheeks push up into the eyes, 0 to 1: a smile.
    var cheeks: Double
    /// How far the brows come down over the eyes, 0 to 1.
    var brows: Double
    /// The brows' slant: positive lifts the inner ends (sad), negative drops them (cross).
    var browSlant: Double
    /// How bright the eyes glow, 0 to 1.
    var glow: Double
    /// The shimmer across the visor, 0 to 1 along it; negative for none.
    var shimmer: Double
    /// The sparks: how visible, 0 to 1, and how long, 0 to 1.2.
    var sparks: Double
    var sparkLength: Double
    /// The ribbon's sway, -1 to 1.
    var sway: Double
    /// The sleeping "z"s, 0 to 1.
    var dozing: Double

    /// Every field, in the web's order, for blending and tests.
    static var fields: [WritableKeyPath<Pose, Double>] {
        [
            \.bob, \.tilt, \.stretch, \.gazeX, \.gazeY, \.eyeLeft, \.eyeRight, \.cheeks, \.brows,
            \.browSlant, \.glow, \.shimmer, \.sparks, \.sparkLength, \.sway, \.dozing,
        ]
    }

    /// Still, eyes open, looking a little to the side: the robot when it isn't moving.
    static let rest = Pose(
        bob: 0, tilt: 0, stretch: 1, gazeX: 0.25, gazeY: 0, eyeLeft: 1, eyeRight: 1, cheeks: 0,
        brows: 0, browSlant: 0, glow: 0.75, shimmer: -1, sparks: 0, sparkLength: 1, sway: 0, dozing: 0)
}

private let tau = Double.pi * 2

private func clamp(_ x: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, x)) }

private func smooth(_ x: Double) -> Double {
    let t = clamp(x, 0, 1)
    return t * t * (3 - 2 * t)
}

private func mix(_ a: Double, _ b: Double, _ k: Double) -> Double { a + (b - a) * k }

extension Pose {
    /// A number in [0, 1) that depends only on `n`.
    static func hash(_ n: Double) -> Double {
        let x = sin(n * 127.1 + 311.7) * 43758.5453
        return x - x.rounded(.down)
    }

    /// How closed the eyes are from blinking, 0 to 1: a blink every few seconds, now and then
    /// two. `every` is the average gap in seconds.
    static func blink(_ t: Double, every: Double = 3.6) -> Double {
        let slot = (t / every).rounded(.down)
        let at = slot * every + hash(slot) * (every - 0.6)
        func one(_ start: Double) -> Double {
            let d = (t - start) / 0.16
            return d < 0 || d > 1 ? 0 : sin(d * .pi)
        }
        return max(one(at), hash(slot + 0.5) < 0.2 ? one(at + 0.24) : 0)
    }

    /// Where it glances: a new spot every `every` seconds, eased between, -1 to 1 on each axis.
    private static func glance(_ t: Double, every: Double, seed: Double) -> (x: Double, y: Double) {
        let slot = (t / every).rounded(.down)
        let into = (t - slot * every) / every
        // It moves to the next spot quickly, then rests there.
        let k = smooth(into / 0.18)
        func spot(_ s: Double) -> (x: Double, y: Double) {
            (hash(s * 3.1 + seed) * 2 - 1, (hash(s * 7.7 + seed) * 2 - 1) * 0.6)
        }
        let from = spot(slot - 1)
        let to = spot(slot)
        return (mix(from.x, to.x, k), mix(from.y, to.y, k))
    }

    /// A made-up voice when no real one is given: syllables with pauses between words.
    static func voice(_ t: Double) -> Double {
        let syllables = 0.5 + 0.5 * sin(t * tau * 4.2) * sin(t * tau * 1.3 + 1)
        let words = smooth(sin(t * tau * 0.45) * 2 + 1.2)
        return clamp(syllables * words, 0, 1)
    }

    /// The pose of `mood` at `t` seconds. `level` is the voice's loudness, 0 to 1, while
    /// listening or speaking; made up when nil.
    static func of(_ mood: Mood, at t: Double, level: Double? = nil) -> Pose {
        let breath = sin(t * tau / 4)
        var base = Pose.rest
        base.bob = breath * 2
        base.stretch = 1 + breath * 0.008
        base.sway = sin(t * tau / 5.3)
        let shut = 1 - blink(t)
        let level = level ?? voice(t)
        var p = base

        switch mood {
        case .idle:
            let (x, y) = glance(t, every: 2.8, seed: 1)
            // A twinkle of the sparks now and then.
            let slot = (t / 7).rounded(.down)
            let twinkle = hash(slot + 9) < 0.5 ? sin(clamp((t - slot * 7 - 2) / 0.8, 0, 1) * .pi) : 0
            p.gazeX = 0.15 + x * 0.55
            p.gazeY = y * 0.5
            p.tilt = x * 3
            p.eyeLeft = shut
            p.eyeRight = shut
            p.sparks = twinkle * 0.6
        case .listening:
            let lean = sin(t * tau / 3) * 0.5 + 0.5
            p.gazeX = 0
            p.gazeY = -0.05
            p.tilt = -6 + lean * 2
            p.bob = base.bob * 0.5 - level * 2
            p.eyeLeft = (1.12 + level * 0.18) * shut
            p.eyeRight = (1.12 + level * 0.18) * shut
            p.glow = 0.8 + level * 0.2
            p.sparks = 0.25 + level * 0.6
            p.sparkLength = 0.6 + level * 0.6
        case .thinking:
            // Eyes go up and to the side and wander a little, as if reading the ceiling.
            let wander = sin(t * tau * 0.6)
            p.gazeX = 0.45 + wander * 0.35
            p.gazeY = -0.7 + sin(t * tau * 0.9) * 0.1
            p.tilt = 4 + wander * 2
            p.eyeLeft = 0.85 * (1 - blink(t, every: 5))
            p.eyeRight = 0.85 * (1 - blink(t, every: 5))
            p.brows = 0.15
            p.browSlant = -0.2
            p.glow = 0.7 + 0.15 * sin(t * tau * 1.5)
            p.shimmer = (t * 0.7).truncatingRemainder(dividingBy: 1.6)
        case .speaking:
            p.gazeX = 0.1
            p.gazeY = 0
            p.bob = base.bob - level * 3
            p.stretch = 1 + level * 0.03
            p.tilt = sin(t * tau * 0.35) * 3
            p.eyeLeft = (0.82 + level * 0.3) * shut
            p.eyeRight = (0.82 + level * 0.3) * shut
            p.cheeks = 0.15 + level * 0.15
            p.glow = 0.7 + level * 0.3
        case .working:
            // Down at its hands, with a quick look up now and then.
            let slot = (t / 3.2).rounded(.down)
            let up = hash(slot + 4) < 0.4 ? sin(clamp((t - slot * 3.2 - 1) / 0.7, 0, 1) * .pi) : 0
            let scan = sin(t * tau * 0.8)
            p.gazeX = 0.35 + scan * 0.3
            p.gazeY = mix(0.65, -0.1, up)
            p.tilt = 5 + scan
            p.eyeLeft = mix(0.8, 1, up) * shut
            p.eyeRight = mix(0.8, 1, up) * shut
            p.brows = 0.2 * (1 - up)
            p.glow = 0.85
            p.sparks = 0.15
        case .waiting:
            // Two nudges, a pause, two nudges: someone has to decide.
            let beat = t.truncatingRemainder(dividingBy: 1.6) / 1.6
            let nudge = max(
                sin(clamp(beat / 0.15, 0, 1) * .pi),
                sin(clamp((beat - 0.2) / 0.15, 0, 1) * .pi))
            p.gazeX = 0
            p.gazeY = 0
            p.bob = base.bob * 0.5 - nudge * 3
            p.tilt = nudge * 6
            p.eyeLeft = 1.1 * shut
            p.eyeRight = 1.1 * shut
            p.cheeks = 0.1
            p.glow = 0.85 + nudge * 0.15
            p.sparks = 0.3 + nudge * 0.7
            p.sparkLength = 0.7 + nudge * 0.5
        case .happy:
            let bounce = abs(sin(t * tau * 0.9))
            p.gazeX = 0
            p.gazeY = -0.1
            p.bob = -bounce * 4
            p.stretch = 1 + bounce * 0.025
            p.tilt = sin(t * tau * 0.45) * 5
            p.eyeLeft = 1
            p.eyeRight = 1
            p.cheeks = 0.85
            p.glow = 1
            p.sparks = 0.5 + bounce * 0.5
            p.sparkLength = 0.9 + bounce * 0.3
        case .puzzled:
            p.gazeX = 0.5
            p.gazeY = -0.35
            p.tilt = 10 + sin(t * tau * 0.3) * 2
            p.eyeLeft = 1.15 * shut
            p.eyeRight = 0.6 * shut
            p.brows = 0.25
            p.browSlant = 0.6
            p.sparks = 0.2
            p.sparkLength = 0.5
        case .sad:
            p.bob = base.bob * 0.4 + 5
            p.stretch = 0.975 + breath * 0.004
            p.gazeX = -0.1
            p.gazeY = 0.6
            p.tilt = -4
            p.eyeLeft = 0.8 * (1 - blink(t, every: 4.5))
            p.eyeRight = 0.8 * (1 - blink(t, every: 4.5))
            p.brows = 0.35
            p.browSlant = 1
            p.glow = 0.45
            p.sway = base.sway * 0.4
        case .asleep:
            let slow = sin(t * tau / 6)
            p.bob = slow * 3 + 4
            p.stretch = 1 + slow * 0.015
            p.gazeX = 0
            p.gazeY = 0.3
            p.tilt = -7 + slow
            p.eyeLeft = 0.07
            p.eyeRight = 0.07
            p.cheeks = 0.2
            p.glow = 0.3
            p.sway = slow * 0.4
            p.dozing = 1
        }
        return p
    }

    /// The pose between two, field by field; `k` 0 is `a`, 1 is `b`.
    static func blend(_ a: Pose, _ b: Pose, _ k: Double) -> Pose {
        var out = a
        for field in fields {
            // The shimmer sweeps rather than fades: it shows only where a pose has one.
            out[keyPath: field] = field == \.shimmer ? (k < 0.5 ? a.shimmer : b.shimmer) : mix(a[keyPath: field], b[keyPath: field], k)
        }
        return out
    }

    /// How far into a change of mood `elapsed` seconds is, eased; changes take 0.35 s.
    static func settle(_ elapsed: Double) -> Double {
        smooth(elapsed / 0.35)
    }
}
