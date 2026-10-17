import type { Context } from "@earendil-works/chord";
import {
  type DocumentReader,
  defineDocFamily,
  type Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { DirectoryDoc } from "./directory.ts";
import type { Players } from "./players.ts";

/** Which pushes a player gets; each kind is on unless turned off. */
export type NotificationPrefs = { answers?: boolean; approvals?: boolean };

// Stored in a document, so plain JSON. The display name lives in the directory, with the player.
export type ProfileState = {
  /** A `data:image/…;base64,` URL. */
  avatar?: string;
  /** IANA, such as `Europe/Oslo`; the assistant's own when absent. */
  timeZone?: string;
  /** BCP 47, such as `nb`; the assistant answers in it. */
  language?: string;
  notifications?: NotificationPrefs;
  /** Each extension's preferences for this player, by extension name. */
  extensions?: Record<string, JsonObject>;
};

/** What a player says about themselves, wherever they use the assistant. */
export type Profile = ProfileState & { displayName: string };

/** Fields to change; `null` clears one. Absent fields stay as they are. */
export type ProfileUpdate = {
  readonly displayName?: string;
  readonly avatar?: string | null;
  readonly timeZone?: string | null;
  readonly language?: string | null;
  readonly notifications?: NotificationPrefs | null;
  /** By extension name: each one named is replaced, `null` clears it; `null` for all clears them all. */
  readonly extensions?: Record<string, JsonObject | null> | null;
};

/**
 * A player's profile, keyed by player id: their time zone, language, avatar and preferences. Their
 * home keeps it and sends it to the other assistants they are in (ADR 10).
 */
export const ProfileDoc = defineDocFamily<ProfileState, null>({
  kind: "nudge.profile",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({}),
});

/** About 64 KiB of image, base64-encoded. */
export const MAX_AVATAR_LENGTH = 90_000;

export class InvalidProfile extends Error {
  override name = "InvalidProfile";
}

/** The players' profiles. */
export class Profiles {
  constructor(
    private readonly harness: Harness,
    private readonly players: Players,
    private readonly changed: (playerId: string) => void = () => {},
    /** Throws `InvalidProfile` when an extension doesn't take what a player chose for it. */
    private readonly checkExtension: (name: string, chosen: JsonObject) => void = () => {},
  ) {}

  /** Undefined for a player who doesn't exist. */
  async get(playerId: string, context: Context): Promise<Profile | undefined> {
    return profileOf(this.harness, playerId, context);
  }

  async update(playerId: string, update: ProfileUpdate, context: Context): Promise<Profile> {
    const player = await this.players.get(playerId, context);
    if (player === undefined) throw new Error(`No player "${playerId}"`);
    check(update);
    for (const [name, chosen] of Object.entries(update.extensions ?? {}))
      if (chosen !== null) this.checkExtension(name, chosen);
    if (update.displayName !== undefined && update.displayName.trim() !== player.displayName)
      await this.players.rename(playerId, update.displayName, context);
    await this.harness.commit(async (tx) => {
      const profile = await tx.doc(ProfileDoc, playerId, null);
      for (const key of ["avatar", "timeZone", "language"] as const) {
        const value = update[key];
        if (value === null) delete profile[key];
        else if (value !== undefined) profile[key] = value;
      }
      if (update.notifications === null) delete profile.notifications;
      else if (update.notifications !== undefined)
        profile.notifications = { ...update.notifications };
      if (update.extensions === null) delete profile.extensions;
      else if (update.extensions !== undefined) {
        const extensions = profile.extensions ?? {};
        for (const [name, chosen] of Object.entries(update.extensions))
          if (chosen === null) delete extensions[name];
          else extensions[name] = structuredClone(chosen);
        if (Object.keys(extensions).length === 0) delete profile.extensions;
        else profile.extensions = extensions;
      }
    }, context);
    this.changed(playerId);
    return (await this.get(playerId, context))!;
  }
}

/** A player's profile as `read` has it; undefined for a player who doesn't exist. */
export async function profileOf(
  read: DocumentReader,
  playerId: string,
  context: Context,
): Promise<Profile | undefined> {
  const player = (await read.snapshot(DirectoryDoc, context))?.players[playerId];
  if (player === undefined) return undefined;
  const state = await read.snapshot(ProfileDoc, playerId, context);
  return { displayName: player.displayName, ...structuredClone(state ?? {}) };
}

function check(update: ProfileUpdate): void {
  if (update.displayName !== undefined && update.displayName.trim() === "")
    throw new InvalidProfile("A player needs a name");
  if (typeof update.timeZone === "string" && !validTimeZone(update.timeZone))
    throw new InvalidProfile(`"${update.timeZone}" is not an IANA time zone`);
  if (typeof update.language === "string" && !validLanguage(update.language))
    throw new InvalidProfile(`"${update.language}" is not a BCP 47 language tag`);
  if (typeof update.avatar === "string") {
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(update.avatar))
      throw new InvalidProfile("An avatar is a base64 data: URL of a PNG, JPEG, WebP or GIF");
    if (update.avatar.length > MAX_AVATAR_LENGTH)
      throw new InvalidProfile("An avatar is at most 64 KiB");
  }
}

export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function validLanguage(language: string): boolean {
  try {
    return Intl.getCanonicalLocales(language).length === 1;
  } catch {
    return false;
  }
}
