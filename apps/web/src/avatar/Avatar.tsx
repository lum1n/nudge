import { useEffect, useId, useRef, useState } from "react";
import { type Appearance, type EyeShape, NUDGE } from "./appearance.ts";
import { blend, type Mood, type Pose, pose, REST, settle } from "./pose.ts";

/**
 * The Nudge robot, alive: it breathes and blinks, and shows `mood`, easing from one mood to the
 * next. `level` is read every frame for the voice's loudness while listening or speaking.
 */
export function Avatar({
  mood,
  appearance = NUDGE,
  size = 96,
  level,
  className,
  title,
}: {
  mood: Mood;
  appearance?: Appearance;
  size?: number;
  level?: () => number;
  className?: string;
  title?: string;
}) {
  const { t, still } = useClock();
  const change = useRef({ from: mood, to: mood, at: t });
  if (change.current.to !== mood) {
    // A change during a change starts from where the last one was going.
    change.current = { from: change.current.to, to: mood, at: t };
  }
  const { from, to, at } = change.current;
  const inputs = { level: level?.() };
  // A still clock never gets through a change, so a still robot shows the new mood at once.
  const k = still ? 1 : settle(t - at);
  const now = k >= 1 ? pose(to, t, inputs) : blend(pose(from, t, inputs), pose(to, t, inputs), k);
  return (
    <Robot
      pose={now}
      t={t}
      appearance={appearance}
      size={size}
      className={className}
      title={title ?? mood}
    />
  );
}

/** The robot at rest, for where many are drawn at once, such as beside every answer. */
export function Portrait({
  appearance = NUDGE,
  size = 20,
  className,
}: {
  appearance?: Appearance;
  size?: number;
  className?: string;
}) {
  return <Robot pose={REST} t={0} appearance={appearance} size={size} className={className} />;
}

/** Seconds since mount, every frame; still for people who asked for less motion. */
function useClock(): { t: number; still: boolean } {
  const [t, setT] = useState(0.9);
  const [still] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (still) return;
    const start = performance.now() - 900;
    let frame = requestAnimationFrame(function tick(now) {
      setT((now - start) / 1000);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [still]);
  return { t, still };
}

const EYES: Record<EyeShape, { w: number; h: number; r: number; turn: number }> = {
  pill: { w: 12, h: 27, r: 6, turn: 8 },
  round: { w: 19, h: 19, r: 9.5, turn: 0 },
  square: { w: 17, h: 17, r: 4, turn: 0 },
  wide: { w: 24, h: 12, r: 6, turn: 0 },
};

/** One pose, drawn on a 200 by 200 canvas. */
export function Robot({
  pose: p,
  t,
  appearance: look,
  size,
  className,
  title,
}: {
  pose: Pose;
  t: number;
  appearance: Appearance;
  size: number;
  className?: string;
  title?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const url = (name: string) => `url(#${id}${name})`;

  // The visor and eyes follow the gaze over the round head, a little narrower to the side.
  const vx = 104 + p.gazeX * 13;
  const vy = 86 + p.gazeY * 9;
  const vw = 86 * (1 - Math.abs(p.gazeX) * 0.1);
  const vh = 64;
  const visor = `M ${vx - vw / 2 + 30} ${vy - vh / 2} H ${vx + vw / 2 - 30} A 30 32 0 0 1 ${vx + vw / 2 - 30} ${vy + vh / 2} H ${vx - vw / 2 + 30} A 30 32 0 0 1 ${vx - vw / 2 + 30} ${vy - vh / 2} Z`;

  const shape = EYES[look.eyeShape];
  const eyes = [
    { x: vx - 17 + p.gazeX * 5, open: p.eyeLeft, side: -1 },
    { x: vx + 17 + p.gazeX * 5, open: p.eyeRight, side: 1 },
  ].map((eye) => ({ ...eye, y: vy + p.gazeY * 7, h: Math.max(1.6, shape.h * eye.open) }));

  const { back, front, face, rim } = ribbon(p.sway);

  // Squash and stretch from the bottom, keeping the volume.
  const robot = `translate(100 ${100 + p.bob}) rotate(${p.tilt}) translate(-100 -100) translate(100 176) scale(${1 / Math.sqrt(p.stretch)} ${p.stretch}) translate(-100 -176)`;
  const lift = Math.max(0, -p.bob);

  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      className={className}
      // Untitled, it sits beside a name, as each answer's portrait does: nothing to read out.
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
    >
      {title && <title>{title}</title>}
      <defs>
        <radialGradient id={`${id}head`} cx="0.62" cy="0.28" r="0.85">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#f3f4ff" />
          <stop offset="0.85" stopColor="#c6ccf6" />
          <stop offset="1" stopColor="#a4b2f2" />
        </radialGradient>
        <radialGradient id={`${id}visor`} cx="0.45" cy="0.35" r="0.75">
          <stop offset="0" stopColor="#141a30" />
          <stop offset="1" stopColor="#03050b" />
        </radialGradient>
        <linearGradient id={`${id}body`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={look.body[0]} />
          <stop offset="1" stopColor={look.body[1]} />
        </linearGradient>
        {/* The ribbon is one piece; its folds are shading inside it, soft, with no edges. */}
        <linearGradient
          id={`${id}ribbon`}
          gradientUnits="userSpaceOnUse"
          x1="15"
          y1="120"
          x2="165"
          y2="160"
        >
          <stop offset="0" stopColor={look.body[0]} />
          <stop offset="0.4" stopColor={look.body[0]} />
          <stop offset="1" stopColor={look.body[1]} />
        </linearGradient>
        {/* The front face, where the ribbon twists over: lighter than the lobe behind it. */}
        <linearGradient
          id={`${id}face`}
          gradientUnits="userSpaceOnUse"
          x1="40"
          y1="110"
          x2="160"
          y2="170"
        >
          <stop
            offset="0"
            stopColor={tint(tint(look.body[0], look.body[1], 0.6), "#ffffff", 0.15)}
          />
          <stop offset="1" stopColor={look.body[1]} />
        </linearGradient>
        <radialGradient id={`${id}depth`} gradientUnits="userSpaceOnUse" cx="34" cy="140" r="34">
          <stop offset="0" stopColor={tint(look.body[0], "#000000", 0.3)} stopOpacity="0.8" />
          <stop offset="1" stopColor={tint(look.body[0], "#000000", 0.25)} stopOpacity="0" />
        </radialGradient>
        <linearGradient
          id={`${id}inside`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="96"
          x2="0"
          y2="132"
        >
          <stop
            offset="0"
            stopColor={tint(tint(look.body[0], look.body[1], 0.3), "#000000", 0.25)}
          />
          <stop offset="1" stopColor={tint(look.body[0], "#000000", 0.6)} />
        </linearGradient>
        <linearGradient
          id={`${id}fold`}
          gradientUnits="userSpaceOnUse"
          x1="38"
          y1="0"
          x2="160"
          y2="0"
        >
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.3" stopColor="#ffffff" stopOpacity="0.45" />
          <stop offset="0.8" stopColor="#ffffff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}sheen`} gradientUnits="userSpaceOnUse" cx="146" cy="146" r="22">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}lift`} gradientUnits="userSpaceOnUse" cx="28" cy="108" r="18">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}soft`} x="-20%" y="-50%" width="140%" height="200%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
        <clipPath id={`${id}ribbonclip`}>
          <path d={front} />
        </clipPath>
        <clipPath id={`${id}headclip`}>
          <circle cx="98" cy="84" r="58" />
        </clipPath>
        <linearGradient id={`${id}eye`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="0.35" stopColor={look.eyes} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}sparks`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor={look.sparks} />
          <stop offset="1" stopColor={look.sparks} stopOpacity="0.75" />
        </linearGradient>
        <linearGradient id={`${id}shimmer`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor={look.eyes} stopOpacity="0.28" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <filter id={`${id}glow`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <clipPath id={`${id}clip`}>
          <path d={visor} />
        </clipPath>
      </defs>

      <ellipse
        cx="100"
        cy="191"
        rx={56 - lift * 2}
        ry="5"
        fill="#0b1640"
        opacity={0.1 - lift * 0.01}
      />

      <g transform={robot}>
        {look.accessory === "headphones" && (
          <path
            d="M 36 90 A 63 63 0 0 1 160 90"
            fill="none"
            stroke="#2a2f45"
            strokeWidth="7"
            strokeLinecap="round"
          />
        )}
        {/* The ribbon is a cup the head sits in: its far side and inside are behind the head. */}
        <path d={back} fill={url("inside")} />
        <circle cx="98" cy="84" r="58" fill={url("head")} />
        {/* A soft shadow on the head where it sinks in. */}
        <path
          d={rim}
          fill="none"
          stroke={tint(look.body[0], "#000000", 0.5)}
          strokeOpacity="0.35"
          strokeWidth="14"
          filter={url("soft")}
          clipPath={url("headclip")}
          transform="translate(0 -5)"
        />
        <Accessory kind={look.accessory} look={look} glow={p.glow} id={id} />

        <path
          d={visor}
          fill="#9fb4ff"
          opacity="0.35"
          transform={`translate(${vx} ${vy}) scale(1.07) translate(${-vx} ${-vy})`}
        />
        <path d={visor} fill={url("visor")} />
        <g clipPath={url("clip")}>
          {p.shimmer >= 0 && (
            <rect
              x={vx - vw / 2 - 40 + p.shimmer * (vw + 40)}
              y={vy - vh}
              width="34"
              height={vh * 2}
              fill={url("shimmer")}
              transform={`rotate(18 ${vx} ${vy})`}
            />
          )}
          {eyes.map((eye) => {
            const lids = url(`lids${eye.side}`);
            const box = {
              x: eye.x - shape.w / 2,
              y: eye.y - eye.h / 2,
              width: shape.w,
              height: eye.h,
              rx: Math.min(shape.r, eye.h / 2),
            };
            return (
              <g key={eye.side} transform={`rotate(${shape.turn} ${eye.x} ${eye.y})`}>
                {/* The lids cut the eye: cheeks push up from below and leave a crescent, a
                    smile; brows come down from above, slanted. */}
                <mask
                  id={`${id}lids${eye.side}`}
                  maskUnits="userSpaceOnUse"
                  x="0"
                  y="0"
                  width="200"
                  height="200"
                >
                  <rect width="200" height="200" fill="white" />
                  <ellipse
                    cx={eye.x}
                    cy={eye.y + eye.h / 2 + shape.h * 0.5 + 6 - p.cheeks * (eye.h * 0.62 + 2)}
                    rx={shape.w * 0.8}
                    ry={shape.h * 0.5 + 4}
                    fill="black"
                  />
                  <rect
                    x={eye.x - shape.w * 1.5}
                    y={eye.y - eye.h / 2 - 32 + p.brows * eye.h * 0.9}
                    width={shape.w * 3}
                    height="30"
                    fill="black"
                    transform={`rotate(${eye.side * p.browSlant * 20} ${eye.x} ${eye.y})`}
                  />
                </mask>
                <g filter={url("glow")} opacity={p.glow}>
                  <rect {...box} fill={look.eyes} mask={lids} />
                </g>
                <g mask={lids}>
                  <rect {...box} fill={look.eyes} opacity={0.55 + p.glow * 0.45} />
                  <rect {...box} fill={url("eye")} />
                </g>
              </g>
            );
          })}
        </g>
        <path d={visor} fill="none" stroke={look.eyes} strokeOpacity="0.18" strokeWidth="1.2" />

        {/* Its front comes up over the chin. */}
        <path d={front} fill={url("ribbon")} />
        <g clipPath={url("ribbonclip")}>
          <rect width="200" height="200" fill={url("depth")} />
          <path d={face} fill={url("face")} filter={url("soft")} />
          <rect width="200" height="200" fill={url("sheen")} />
          <rect width="200" height="200" fill={url("lift")} />
        </g>
        <path d={rim} fill="none" stroke={url("fold")} strokeWidth="1.5" strokeLinecap="round" />

        {p.sparks > 0.01 && (
          <g
            opacity={p.sparks}
            stroke={url("sparks")}
            strokeWidth="9"
            strokeLinecap="round"
            filter={undefined}
          >
            <Spark x={150} y={40} dx={13} dy={-22} length={p.sparkLength} />
            <Spark x={162} y={62} dx={22} dy={-12} length={p.sparkLength} />
          </g>
        )}
      </g>

      {p.dozing > 0.01 &&
        [0, 1, 2].map((n) => {
          const phase = (t / 3 + n / 3) % 1;
          return (
            <text
              key={n}
              x={150 + phase * 18 + n * 4}
              y={60 - phase * 44}
              fontSize={11 + phase * 9}
              fontWeight="700"
              fontFamily="system-ui, sans-serif"
              fill={tint(look.body[0], look.body[1], 0.5)}
              opacity={p.dozing * Math.sin(phase * Math.PI) * 0.9}
            >
              z
            </text>
          );
        })}
    </svg>
  );
}

type Point = readonly [number, number];

/** A smooth curve through `points` (Catmull-Rom as cubic Béziers), closed unless `open`. */
function smooth(points: readonly Point[], open = false): string {
  const n = points.length;
  const at = (i: number) =>
    open ? points[Math.min(n - 1, Math.max(0, i))]! : points[(i + n) % n]!;
  const f = (x: number) => x.toFixed(2);
  let d = `M ${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let i = 0; i < (open ? n - 1 : n); i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += ` C ${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return open ? d : `${d} Z`;
}

/**
 * The ribbon the head sits in, after the app icon: a cup, round at both ends, with a lobe on the
 * left beside the head and an end under the right cheek. Its `back` reaches up behind the head;
 * its `front` comes up only to the `rim`, low under the chin, so the head sits in it, not behind
 * it. The ends sway a little.
 */
function ribbon(sway: number): { back: string; front: string; face: string; rim: string } {
  const l = sway * 1.2;
  const r = sway * 1.8;
  const left: Point = [30 - l, 100];
  const right: Point = [163, 117 + r * 0.8];
  // Round the bottom from the left end to the right one.
  const bottom: Point[] = [
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
  ];
  // The front's edge, from the left end to the right one: low under the chin.
  const edge: Point[] = [
    [44, 114],
    [62, 128],
    [86, 138],
    [108, 141],
    [130, 137 + r * 0.3],
    [150, 128 + r * 0.6],
  ];
  // The far side, behind the head, from the right end to the left one.
  const far: Point[] = [
    [158, 106 + r * 0.5],
    [130, 99],
    [98, 97],
    [64, 97],
    [42, 95],
  ];
  const back = smooth([left, ...bottom, right, ...far]);
  const front = smooth([left, ...bottom, right, ...edge.slice().reverse()]);
  // The face where the ribbon twists over on the left: from the rim down to the right end and
  // the bottom, and back up the twist.
  const face = smooth([
    ...edge,
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
  ]);
  return { back, front, face, rim: smooth([left, ...edge, right], true) };
}

/** `from` moved toward `to` by `k`, both `#rrggbb`. */
function tint(from: string, to: string, k: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const mixed = [0, 1, 2].map((i) =>
    Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * k),
  );
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** A spark that grows out from where it starts. */
function Spark({
  x,
  y,
  dx,
  dy,
  length,
}: {
  x: number;
  y: number;
  dx: number;
  dy: number;
  length: number;
}) {
  // It starts a little away from the head and reaches out.
  const gap = (1 - Math.min(1, length)) * 0.4;
  return (
    <line
      x1={x + dx * gap}
      y1={y + dy * gap}
      x2={x + dx * length}
      y2={y + dy * length}
      fill="none"
    />
  );
}

function Accessory({
  kind,
  look,
  glow,
  id,
}: {
  kind: Appearance["accessory"];
  look: Appearance;
  glow: number;
  id: string;
}) {
  switch (kind) {
    case "none":
      return null;
    case "antenna":
      return (
        <g>
          <path
            d="M 96 27 Q 92 14 100 6"
            fill="none"
            stroke="#a4b2f2"
            strokeWidth="4"
            strokeLinecap="round"
          />
          <circle
            cx="100"
            cy="6"
            r="7"
            fill={look.sparks}
            opacity={glow}
            filter={`url(#${id}glow)`}
          />
          <circle cx="100" cy="6" r="5.5" fill={look.sparks} />
        </g>
      );
    case "headphones":
      return (
        <g fill={`url(#${id}body)`}>
          <rect x="28" y="70" width="17" height="36" rx="8.5" />
          <rect x="151" y="70" width="17" height="36" rx="8.5" />
        </g>
      );
    case "sprout":
      return (
        <g>
          <path
            d="M 98 27 Q 97 16 100 10"
            fill="none"
            stroke="#3aa65a"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <path d="M 100 12 C 92 2 80 4 78 12 C 86 16 95 16 100 12 Z" fill="#5cd36e" />
          <path d="M 100 12 C 106 0 120 0 122 8 C 114 14 105 15 100 12 Z" fill="#7be27f" />
        </g>
      );
    case "crown":
      return (
        <path
          d="M 76 33 L 72 12 L 86 22 L 98 6 L 110 22 L 124 12 L 120 33 Q 98 27 76 33 Z"
          fill="#ffc83d"
          stroke="#e8a317"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      );
  }
}
