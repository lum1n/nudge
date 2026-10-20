// The Nudge robot's motion, apart from how it is drawn: what it feels and the time give a pose of
// plain numbers. The renderers on every platform draw the same pose, so the robot moves the same
// everywhere; nothing here is random, the same moment always gives the same pose.

/** What the robot is doing, from what the room is doing. */
export type Mood =
  | "idle" // nothing going on: breathes, blinks, looks around
  | "listening" // someone is dictating: eyes wide, following the voice
  | "thinking" // a turn is running: looks up, the visor shimmers
  | "speaking" // the answer is coming: eyes bounce with it
  | "working" // a tool is running: looks down at its work
  | "waiting" // an approval waits for someone: nudges, the sparks flash
  | "happy" // a turn just ended well
  | "puzzled" // retrying after an error
  | "sad" // a turn failed
  | "asleep"; // nothing for a long while

export const MOODS: readonly Mood[] = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "working",
  "waiting",
  "happy",
  "puzzled",
  "sad",
  "asleep",
];

export interface Pose {
  /** Up and down, in units of the 200-wide canvas; up is negative. */
  bob: number;
  /** Head tilt in degrees, clockwise. */
  tilt: number;
  /** Squash and stretch of the whole robot: 1 is at rest, more is taller. */
  stretch: number;
  /** Where it looks, -1 to 1 (right and down are positive). */
  gazeX: number;
  gazeY: number;
  /** How open each eye is, 0 to about 1.3. */
  eyeLeft: number;
  eyeRight: number;
  /** How far the cheeks push up into the eyes, 0 to 1: a smile. */
  cheeks: number;
  /** How far the brows come down over the eyes, 0 to 1. */
  brows: number;
  /** The brows' slant: positive lifts the inner ends (sad), negative drops them (cross). */
  browSlant: number;
  /** How bright the eyes glow, 0 to 1. */
  glow: number;
  /** The shimmer across the visor, 0 to 1 along it; negative for none. */
  shimmer: number;
  /** The sparks: how visible, 0 to 1, and how long, 0 to 1.2. */
  sparks: number;
  sparkLength: number;
  /** The ribbon's sway, -1 to 1. */
  sway: number;
  /** The sleeping "z"s, 0 to 1. */
  dozing: number;
}

export interface Inputs {
  /** The voice's loudness, 0 to 1, while listening or speaking; made up when absent. */
  level?: number;
}

const TAU = Math.PI * 2;

/** A number in [0, 1) that depends only on `n`. */
export function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * How closed the eyes are from blinking, 0 to 1: a blink every few seconds, now and then two.
 * `every` is the average gap in seconds.
 */
export function blink(t: number, every = 3.6): number {
  const slot = Math.floor(t / every);
  const at = slot * every + hash(slot) * (every - 0.6);
  const one = (start: number) => {
    const d = (t - start) / 0.16;
    return d < 0 || d > 1 ? 0 : Math.sin(d * Math.PI);
  };
  return Math.max(one(at), hash(slot + 0.5) < 0.2 ? one(at + 0.24) : 0);
}

/** Where it glances: a new spot every `every` seconds, eased between, -1 to 1 on each axis. */
function glance(t: number, every: number, seed: number): [number, number] {
  const slot = Math.floor(t / every);
  const into = (t - slot * every) / every;
  // It moves to the next spot quickly, then rests there.
  const k = smooth(into / 0.18);
  const spot = (s: number): [number, number] => [
    hash(s * 3.1 + seed) * 2 - 1,
    (hash(s * 7.7 + seed) * 2 - 1) * 0.6,
  ];
  const [x0, y0] = spot(slot - 1);
  const [x1, y1] = spot(slot);
  return [mix(x0, x1, k), mix(y0, y1, k)];
}

/** A made-up voice when no real one is given: syllables with pauses between words. */
export function voice(t: number): number {
  const syllables = 0.5 + 0.5 * Math.sin(t * TAU * 4.2) * Math.sin(t * TAU * 1.3 + 1);
  const words = smooth(Math.sin(t * TAU * 0.45) * 2 + 1.2);
  return clamp(syllables * words, 0, 1);
}

/** Still, eyes open, looking a little to the side: the robot when it isn't moving. */
export const REST: Pose = {
  bob: 0,
  tilt: 0,
  stretch: 1,
  gazeX: 0.25,
  gazeY: 0,
  eyeLeft: 1,
  eyeRight: 1,
  cheeks: 0,
  brows: 0,
  browSlant: 0,
  glow: 0.75,
  shimmer: -1,
  sparks: 0,
  sparkLength: 1,
  sway: 0,
  dozing: 0,
};

/** The pose of `mood` at `t` seconds. */
export function pose(mood: Mood, t: number, inputs: Inputs = {}): Pose {
  const breath = Math.sin((t * TAU) / 4);
  const base: Pose = {
    ...REST,
    bob: breath * 2,
    stretch: 1 + breath * 0.008,
    sway: Math.sin((t * TAU) / 5.3),
  };
  const shut = 1 - blink(t);
  const level = inputs.level ?? voice(t);

  switch (mood) {
    case "idle": {
      const [x, y] = glance(t, 2.8, 1);
      // A twinkle of the sparks now and then.
      const slot = Math.floor(t / 7);
      const twinkle =
        hash(slot + 9) < 0.5 ? Math.sin(clamp((t - slot * 7 - 2) / 0.8, 0, 1) * Math.PI) : 0;
      return {
        ...base,
        gazeX: 0.15 + x * 0.55,
        gazeY: y * 0.5,
        tilt: x * 3,
        eyeLeft: shut,
        eyeRight: shut,
        sparks: twinkle * 0.6,
      };
    }
    case "listening": {
      const lean = Math.sin((t * TAU) / 3) * 0.5 + 0.5;
      return {
        ...base,
        gazeX: 0,
        gazeY: -0.05,
        tilt: -6 + lean * 2,
        bob: base.bob * 0.5 - level * 2,
        eyeLeft: (1.12 + level * 0.18) * shut,
        eyeRight: (1.12 + level * 0.18) * shut,
        glow: 0.8 + level * 0.2,
        sparks: 0.25 + level * 0.6,
        sparkLength: 0.6 + level * 0.6,
      };
    }
    case "thinking": {
      // Eyes go up and to the side and wander a little, as if reading the ceiling.
      const wander = Math.sin(t * TAU * 0.6);
      return {
        ...base,
        gazeX: 0.45 + wander * 0.35,
        gazeY: -0.7 + Math.sin(t * TAU * 0.9) * 0.1,
        tilt: 4 + wander * 2,
        eyeLeft: 0.85 * (1 - blink(t, 5)),
        eyeRight: 0.85 * (1 - blink(t, 5)),
        brows: 0.15,
        browSlant: -0.2,
        glow: 0.7 + 0.15 * Math.sin(t * TAU * 1.5),
        shimmer: (t * 0.7) % 1.6,
      };
    }
    case "speaking": {
      return {
        ...base,
        gazeX: 0.1,
        gazeY: 0,
        bob: base.bob - level * 3,
        stretch: 1 + level * 0.03,
        tilt: Math.sin(t * TAU * 0.35) * 3,
        eyeLeft: (0.82 + level * 0.3) * shut,
        eyeRight: (0.82 + level * 0.3) * shut,
        cheeks: 0.15 + level * 0.15,
        glow: 0.7 + level * 0.3,
      };
    }
    case "working": {
      // Down at its hands, with a quick look up now and then.
      const slot = Math.floor(t / 3.2);
      const up =
        hash(slot + 4) < 0.4 ? Math.sin(clamp((t - slot * 3.2 - 1) / 0.7, 0, 1) * Math.PI) : 0;
      const scan = Math.sin(t * TAU * 0.8);
      return {
        ...base,
        gazeX: 0.35 + scan * 0.3,
        gazeY: mix(0.65, -0.1, up),
        tilt: 5 + scan,
        eyeLeft: mix(0.8, 1, up) * shut,
        eyeRight: mix(0.8, 1, up) * shut,
        brows: 0.2 * (1 - up),
        glow: 0.85,
        sparks: 0.15,
      };
    }
    case "waiting": {
      // Two nudges, a pause, two nudges: someone has to decide.
      const beat = (t % 1.6) / 1.6;
      const nudge = Math.max(
        Math.sin(clamp(beat / 0.15, 0, 1) * Math.PI),
        Math.sin(clamp((beat - 0.2) / 0.15, 0, 1) * Math.PI),
      );
      return {
        ...base,
        gazeX: 0,
        gazeY: 0,
        bob: base.bob * 0.5 - nudge * 3,
        tilt: nudge * 6,
        eyeLeft: 1.1 * shut,
        eyeRight: 1.1 * shut,
        cheeks: 0.1,
        glow: 0.85 + nudge * 0.15,
        sparks: 0.3 + nudge * 0.7,
        sparkLength: 0.7 + nudge * 0.5,
      };
    }
    case "happy": {
      const bounce = Math.abs(Math.sin(t * TAU * 0.9));
      return {
        ...base,
        gazeX: 0,
        gazeY: -0.1,
        bob: -bounce * 4,
        stretch: 1 + bounce * 0.025,
        tilt: Math.sin(t * TAU * 0.45) * 5,
        eyeLeft: 1,
        eyeRight: 1,
        cheeks: 0.85,
        glow: 1,
        sparks: 0.5 + bounce * 0.5,
        sparkLength: 0.9 + bounce * 0.3,
      };
    }
    case "puzzled": {
      return {
        ...base,
        gazeX: 0.5,
        gazeY: -0.35,
        tilt: 10 + Math.sin(t * TAU * 0.3) * 2,
        eyeLeft: 1.15 * shut,
        eyeRight: 0.6 * shut,
        brows: 0.25,
        browSlant: 0.6,
        sparks: 0.2,
        sparkLength: 0.5,
      };
    }
    case "sad": {
      return {
        ...base,
        bob: base.bob * 0.4 + 5,
        stretch: 0.975 + breath * 0.004,
        gazeX: -0.1,
        gazeY: 0.6,
        tilt: -4,
        eyeLeft: 0.8 * (1 - blink(t, 4.5)),
        eyeRight: 0.8 * (1 - blink(t, 4.5)),
        brows: 0.35,
        browSlant: 1,
        glow: 0.45,
        sway: base.sway * 0.4,
      };
    }
    case "asleep": {
      const slow = Math.sin((t * TAU) / 6);
      return {
        ...base,
        bob: slow * 3 + 4,
        stretch: 1 + slow * 0.015,
        gazeX: 0,
        gazeY: 0.3,
        tilt: -7 + slow,
        eyeLeft: 0.07,
        eyeRight: 0.07,
        cheeks: 0.2,
        glow: 0.3,
        sway: slow * 0.4,
        dozing: 1,
      };
    }
  }
}

/** The pose between two, field by field; `k` 0 is `a`, 1 is `b`. */
export function blend(a: Pose, b: Pose, k: number): Pose {
  const out = { ...a };
  for (const key of Object.keys(a) as (keyof Pose)[]) {
    // The shimmer sweeps rather than fades: it shows only where a pose has one.
    out[key] = key === "shimmer" ? (k < 0.5 ? a.shimmer : b.shimmer) : mix(a[key], b[key], k);
  }
  return out;
}

/** How far into a change of mood `elapsed` seconds is, eased; changes take 0.35 s. */
export function settle(elapsed: number): number {
  return smooth(elapsed / 0.35);
}
