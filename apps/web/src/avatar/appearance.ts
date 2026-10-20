// How an assistant's robot looks: a few choices, not a picture, so it stays small, recolours on
// every platform, and everyone in a room sees the same one. The server keeps it (`Appearance` in
// protocol v1).
import type { Appearance } from "@nudge/client";

export type { Appearance };
export type EyeShape = Appearance["eyeShape"];
export type Accessory = Appearance["accessory"];

export const EYE_SHAPES: readonly EyeShape[] = ["pill", "round", "square", "wide"];
export const ACCESSORIES: readonly Accessory[] = [
  "none",
  "antenna",
  "headphones",
  "sprout",
  "crown",
];

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

/**
 * The look to draw for what the server says: the app icon's when it says none, and the icon's eyes
 * or nothing worn for a choice made by a newer app than this one.
 */
export function lookOf(appearance: Appearance | undefined): Appearance {
  if (appearance === undefined) return NUDGE;
  return {
    ...appearance,
    eyeShape: EYE_SHAPES.includes(appearance.eyeShape) ? appearance.eyeShape : NUDGE.eyeShape,
    accessory: ACCESSORIES.includes(appearance.accessory) ? appearance.accessory : "none",
  };
}
