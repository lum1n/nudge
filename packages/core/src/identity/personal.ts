import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  defineDocFamily,
  type Harness,
  type PromptSection,
  section,
} from "@earendil-works/pi-durable";
import type { Turn } from "../privacy/turn.ts";
import type { VaultEntry } from "../privacy/vault.ts";
import { DirectoryDoc } from "./directory.ts";
import type { Players } from "./players.ts";
import { ProfileDoc } from "./profiles.ts";

/** The details a player can give, and the placeholder kind each value is kept under. */
export const PERSONAL_FIELDS = {
  fullName: "NAME",
  email: "EMAIL",
  phone: "PHONE",
  address: "ADDRESS",
} as const;

export type PersonalField = keyof typeof PERSONAL_FIELDS;

// Stored in a document, so plain JSON. Placeholders only: the values are in the vault, owned by
// the player (ADR 9).
export type PersonalState = { [field in PersonalField]?: string } & {
  location?: { placeholder: string; at: number };
};

/** A player's details as they see them. */
export type PersonalDetails = { [field in PersonalField]?: string } & {
  /** Where their device last said they were, and when. */
  location?: { text: string; at: number };
};

/** Where a device is: coordinates, and the place it named, if any, such as a street address. */
export type LocationUpdate = {
  readonly latitude: number;
  readonly longitude: number;
  readonly place?: string;
};

/** Fields to change; `null` or an empty string clears one. Absent fields stay as they are. */
export type PersonalUpdate = { readonly [field in PersonalField]?: string | null } & {
  readonly location?: LocationUpdate | null;
};

/**
 * A player's personal details, keyed by player id: their full name, e-mail, phone, address and
 * where they are. Kept on this assistant only: not part of the profile, so their home never sends
 * them to other assistants.
 */
export const PersonalDoc = defineDocFamily<PersonalState, null>({
  kind: "nudge.personal",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({}),
});

export const MAX_PERSONAL_LENGTH = 200;
/** A location closer than this to the one before keeps its placeholder, so prompts stay cached. */
const SAME_PLACE_METERS = 100;

export class InvalidPersonal extends Error {
  override name = "InvalidPersonal";
}

/** What `Personal` needs of the vault. */
export type PersonalValues = {
  /** Protects a value, as `owner`'s alone if given, and gives its placeholder. */
  readonly protect: (value: string, kind: string, owner?: string) => Promise<string>;
  readonly forget: (placeholder: string) => Promise<void>;
  readonly entry: (placeholder: string) => VaultEntry | undefined;
};

/**
 * Players' personal details. Each value goes into the vault as the player's own, so the model and
 * everyone else only ever see its placeholder; the model is told the placeholders in the player's
 * personal room and private turns (`personalSection`), and tools get the values back.
 */
export class Personal {
  constructor(
    private readonly harness: Harness,
    private readonly players: Players,
    private readonly values: PersonalValues,
    private readonly now: () => number,
  ) {}

  /** Undefined for a player who doesn't exist. */
  async get(playerId: string, context: Context): Promise<PersonalDetails | undefined> {
    if ((await this.players.get(playerId, context)) === undefined) return undefined;
    const state = (await this.harness.snapshot(PersonalDoc, playerId, context)) ?? {};
    const details: PersonalDetails = {};
    for (const field of Object.keys(PERSONAL_FIELDS) as PersonalField[]) {
      const value = this.value(state[field]);
      if (value !== undefined) details[field] = value;
    }
    const location = this.value(state.location?.placeholder);
    if (location !== undefined && state.location !== undefined)
      details.location = { text: location, at: state.location.at };
    return details;
  }

  async update(
    playerId: string,
    update: PersonalUpdate,
    context: Context,
  ): Promise<PersonalDetails> {
    if ((await this.players.get(playerId, context)) === undefined)
      throw new Error(`No player "${playerId}"`);
    check(update);
    const before = (await this.harness.snapshot(PersonalDoc, playerId, context)) ?? {};
    // Everyone in a room sees who wrote what: a full name that is also someone's display name
    // is protected, but not made private, which would hide the name from the others.
    const names = new Set(
      (await this.players.list(context)).map((player) => player.displayName.trim().toLowerCase()),
    );
    const set: Partial<Record<PersonalField, string | null>> = {};
    for (const [field, kind] of Object.entries(PERSONAL_FIELDS) as [PersonalField, string][]) {
      const given = update[field];
      if (given === undefined) continue;
      const value = given?.trim() ?? "";
      const owner = names.has(value.toLowerCase()) ? undefined : playerId;
      set[field] = value === "" ? null : await this.values.protect(value, kind, owner);
    }
    let location: PersonalState["location"] | null | undefined;
    if (update.location === null) location = null;
    else if (update.location !== undefined) {
      const kept = this.samePlace(before.location?.placeholder, update.location);
      location = {
        placeholder:
          kept ?? (await this.values.protect(locationText(update.location), "LOCATION", playerId)),
        at: this.now(),
      };
    }
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(PersonalDoc, playerId, null);
      for (const [field, placeholder] of Object.entries(set) as [PersonalField, string | null][])
        if (placeholder === null) delete state[field];
        else state[field] = placeholder;
      if (location === null) delete state.location;
      else if (location !== undefined) state.location = location;
    }, context);
    // Where someone was is not kept: an old location is forgotten once a new one takes its place.
    const old = before.location?.placeholder;
    if (old !== undefined && location !== undefined && location?.placeholder !== old) {
      if (this.values.entry(old)?.owner === playerId) await this.values.forget(old);
    }
    return (await this.get(playerId, context))!;
  }

  private value(placeholder: string | undefined): string | undefined {
    if (placeholder === undefined) return undefined;
    const entry = this.values.entry(placeholder);
    return entry === undefined || entry.forgotten ? undefined : entry.value;
  }

  /** The old location's placeholder when `next` is the same place, near enough. */
  private samePlace(placeholder: string | undefined, next: LocationUpdate): string | undefined {
    const text = this.value(placeholder);
    if (text === undefined || text !== locationText(next, coordinatesIn(text))) return undefined;
    return placeholder;
  }
}

/**
 * How a location is kept: the place, if the device named one, and coordinates to about 10 m.
 * With `near`, coordinates within `SAME_PLACE_METERS` of it are written as `near` is.
 */
export function locationText(
  location: LocationUpdate,
  near?: { latitude: number; longitude: number },
): string {
  const close = near !== undefined && distanceMeters(near, location) < SAME_PLACE_METERS;
  const { latitude, longitude } = close ? near : location;
  const coordinates = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  const place = location.place?.trim();
  return place === undefined || place === "" ? coordinates : `${place} (${coordinates})`;
}

function coordinatesIn(text: string): { latitude: number; longitude: number } | undefined {
  const match = /(-?\d+\.\d+), (-?\d+\.\d+)\)?$/.exec(text);
  return match === null ? undefined : { latitude: Number(match[1]), longitude: Number(match[2]) };
}

function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function check(update: PersonalUpdate): void {
  for (const field of Object.keys(PERSONAL_FIELDS) as PersonalField[]) {
    const value = update[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new InvalidPersonal(`${field} must be text`);
    const trimmed = value.trim();
    if (trimmed.length > MAX_PERSONAL_LENGTH)
      throw new InvalidPersonal(`${field} is at most ${MAX_PERSONAL_LENGTH} characters`);
    if (trimmed.length === 1) throw new InvalidPersonal(`${field} is too short`);
  }
  const email = update.email?.trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new InvalidPersonal(`"${email}" is not an e-mail address`);
  const phone = update.phone?.trim();
  if (phone && (!/^\+?[\d\s().-]+$/.test(phone) || phone.replace(/\D/g, "").length < 5))
    throw new InvalidPersonal(`"${phone}" is not a phone number`);
  const location = update.location;
  if (location === undefined || location === null) return;
  const { latitude, longitude, place } = location;
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90)
    throw new InvalidPersonal("latitude is between -90 and 90");
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180)
    throw new InvalidPersonal("longitude is between -180 and 180");
  if (place !== undefined && (typeof place !== "string" || place.length > MAX_PERSONAL_LENGTH))
    throw new InvalidPersonal(`place is text of at most ${MAX_PERSONAL_LENGTH} characters`);
}

const LABELS: Record<PersonalField, string> = {
  fullName: "Full name",
  email: "E-mail",
  phone: "Phone",
  address: "Address",
};

/**
 * The `personal` section: the details of the player whose personal room this is, or whose
 * private turn it is, as placeholders. Nowhere else, so nobody can have the assistant hand them
 * to someone else, and not in side conversations, which talk to people outside.
 */
export function personalSection(
  turn: (conversationId: ConversationId, context: Context) => Promise<Turn>,
  /** Whether the vault can still put a placeholder's value back. */
  known: (placeholder: string) => boolean,
  /** The assistant's time zone, for a player who set none. */
  timeZone: string,
): PromptSection {
  return section("personal", async (input, context) => {
    const directory = await input.read.snapshot(DirectoryDoc, context);
    if (directory?.sides?.[String(input.conversationId)] !== undefined) return undefined;
    const room = Object.values(directory?.rooms ?? {}).find(
      (r) => r.conversationId === input.conversationId,
    );
    if (room === undefined) return undefined;
    const playerId =
      room.kind === "personal"
        ? room.members[0]
        : (await turn(input.conversationId, context)).privateTo?.playerId;
    const player = playerId === undefined ? undefined : directory?.players[playerId];
    if (player === undefined) return undefined;
    const state = await input.read.snapshot(PersonalDoc, player.id, context);
    if (state === undefined) return undefined;
    const lines: string[] = [];
    for (const field of Object.keys(PERSONAL_FIELDS) as PersonalField[]) {
      const placeholder = state[field];
      if (placeholder !== undefined && known(placeholder))
        lines.push(`- ${LABELS[field]}: ${placeholder}`);
    }
    if (state.location !== undefined && known(state.location.placeholder)) {
      const profile = await input.read.snapshot(ProfileDoc, player.id, context);
      const at = formatAt(state.location.at, profile?.timeZone ?? timeZone);
      lines.push(`- Where they are now: ${state.location.placeholder} (as of ${at})`);
    }
    if (lines.length === 0) return undefined;
    return [
      `${player.displayName}'s personal details, for filling in forms, writing to people and ` +
        `finding what is near them. The values are kept from you: write the placeholders as ` +
        `they are, and tools get the real values. Use them only for what ${player.displayName} ` +
        `asks.`,
      ...lines,
    ].join("\n");
  });
}

/** To the hour, so a location that only moved a little doesn't change the prompt. */
function formatAt(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(Math.floor(at / 3_600_000) * 3_600_000));
}
