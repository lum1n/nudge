// How an assistant's robot looks: a few choices, not a picture, so it stays small, recolours on
// every platform, and everyone in a room sees the same one.

export type EyeShape = "pill" | "round" | "square" | "wide";
export type Accessory = "none" | "antenna" | "headphones" | "sprout" | "crown";

export const EYE_SHAPES: readonly EyeShape[] = ["pill", "round", "square", "wide"];
export const ACCESSORIES: readonly Accessory[] = [
  "none",
  "antenna",
  "headphones",
  "sprout",
  "crown",
];

export interface Appearance {
  /** The ribbon's two ends, as `#rrggbb`. */
  body: [string, string];
  eyes: string;
  sparks: string;
  eyeShape: EyeShape;
  accessory: Accessory;
}

/** The robot of the app icon. */
export const NUDGE: Appearance = {
  body: ["#1438f5", "#19e6f0"],
  eyes: "#3ff6ff",
  sparks: "#2fe6b8",
  eyeShape: "pill",
  accessory: "none",
};

export const PRESETS: Readonly<Record<string, Appearance>> = {
  Nudge: NUDGE,
  Ember: { ...NUDGE, body: ["#e8361c", "#ffb238"], eyes: "#ffd36b", sparks: "#ff7a45" },
  Moss: {
    ...NUDGE,
    body: ["#127a4a", "#a5e86a"],
    eyes: "#b8ff8a",
    sparks: "#e4f36a",
    eyeShape: "round",
  },
  Grape: {
    ...NUDGE,
    body: ["#5b21d6", "#e45bff"],
    eyes: "#f0a8ff",
    sparks: "#ff6fcf",
    eyeShape: "wide",
  },
  Graphite: {
    ...NUDGE,
    body: ["#30343c", "#8a94a6"],
    eyes: "#ffffff",
    sparks: "#c9d1de",
    eyeShape: "square",
  },
};
