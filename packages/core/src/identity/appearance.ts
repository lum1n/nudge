import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { DirectoryDoc } from "./directory.ts";

export const EYE_SHAPES = ["pill", "round", "square", "wide"] as const;
export const ACCESSORIES = ["none", "antenna", "headphones", "sprout", "crown"] as const;

/**
 * How the assistant's robot looks in the apps: a few choices rather than a picture, so every app
 * draws and recolours it, and everyone who uses the assistant sees the same one. Colours are
 * `#rrggbb`.
 */
export type Appearance = {
  /** The ribbon's two ends. */
  body: [string, string];
  eyes: string;
  sparks: string;
  eyeShape: (typeof EYE_SHAPES)[number];
  accessory: (typeof ACCESSORIES)[number];
};

export class InvalidAppearance extends Error {
  override name = "InvalidAppearance";
}

/** The assistant's look, kept in its directory, so room lists show a change as it happens. */
export class Looks {
  constructor(
    private readonly harness: Harness,
    private readonly changed: () => void = () => {},
  ) {}

  /** Undefined until someone picks one: the apps draw the robot of the app icon. */
  async get(context: Context): Promise<Appearance | undefined> {
    const appearance = (await this.harness.snapshot(DirectoryDoc, context))?.appearance;
    return appearance === undefined ? undefined : structuredClone(appearance);
  }

  /** `null` goes back to the app icon's look. */
  async set(appearance: Appearance | null, context: Context): Promise<Appearance | undefined> {
    if (appearance !== null) check(appearance);
    await this.harness.commit(async (tx) => {
      const directory = await tx.doc(DirectoryDoc);
      if (appearance === null) delete directory.appearance;
      else directory.appearance = structuredClone(appearance);
    }, context);
    this.changed();
    return this.get(context);
  }
}

const COLOUR = /^#[0-9a-f]{6}$/i;

function check(appearance: Appearance): void {
  const colours = [...appearance.body, appearance.eyes, appearance.sparks];
  if (appearance.body.length !== 2 || colours.some((colour) => !COLOUR.test(colour)))
    throw new InvalidAppearance("Colours are #rrggbb, and the ribbon has two");
  if (!EYE_SHAPES.includes(appearance.eyeShape))
    throw new InvalidAppearance(`Eyes are one of ${EYE_SHAPES.join(", ")}`);
  if (!ACCESSORIES.includes(appearance.accessory))
    throw new InvalidAppearance(`The robot wears one of ${ACCESSORIES.join(", ")}`);
}
