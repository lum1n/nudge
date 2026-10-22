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
import { DirectoryDoc, type DirectoryState } from "./directory.ts";
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
  /** The location's text, and its coordinates on their own, for tools that take them apart. */
  location?: { placeholder: string; latitude?: string; longitude?: string; at: number };
  /** Shared rooms where the player lets the model know where they are, for anyone there. */
  rooms?: string[];
};

/** A player's details as they see them. */
export type PersonalDetails = { [field in PersonalField]?: string } & {
  /** Where their device last said they were, and when. */
  location?: { text: string; at: number };
  /** The shared rooms where they let the model know where they are. */
  locationRooms?: string[];
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
  /** A placeholder for a value that stays readable everywhere, as names are (ADR 15). */
  readonly readable: (value: string, kind: string) => Promise<string>;
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
    /** Who the model knows the location of changed in `playerId`'s rooms. */
    private readonly changed: (playerId: string) => void = () => {},
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
    if (state.rooms !== undefined && state.rooms.length > 0)
      details.locationRooms = [...state.rooms];
    return details;
  }

  /**
   * Lets the model know where the player is in a shared room they are in, for anyone there, or
   * stops it. Their personal room and private turns always have it; nowhere else does without this.
   */
  async shareLocation(
    playerId: string,
    roomId: string,
    shared: boolean,
    context: Context,
  ): Promise<PersonalDetails> {
    if ((await this.players.get(playerId, context)) === undefined)
      throw new Error(`No player "${playerId}"`);
    const room = (await this.harness.snapshot(DirectoryDoc, context))?.rooms[roomId];
    if (room === undefined || !room.members.includes(playerId))
      throw new InvalidPersonal(`You are not in a room "${roomId}"`);
    if (room.kind !== "shared")
      throw new InvalidPersonal("Where you are can be shared in shared rooms only");
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(PersonalDoc, playerId, null);
      const rooms = new Set(state.rooms ?? []);
      if (shared) rooms.add(roomId);
      else rooms.delete(roomId);
      if (rooms.size === 0) delete state.rooms;
      else state.rooms = [...rooms].sort();
    }, context);
    this.changed(playerId);
    return (await this.get(playerId, context))!;
  }

  /** The members whose location the model may know in a room (see `sharersOf`). */
  async sharingIn(roomId: string, context: Context): Promise<string[]> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    return sharersOf(directory, roomId, (playerId) =>
      this.harness.snapshot(PersonalDoc, playerId, context),
    );
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
    // stays as readable as the display name, written as it is there.
    const names = new Map(
      (await this.players.list(context)).map((player) => [
        player.displayName.trim().toLowerCase(),
        player.displayName.trim(),
      ]),
    );
    const set: Partial<Record<PersonalField, string | null>> = {};
    for (const [field, kind] of Object.entries(PERSONAL_FIELDS) as [PersonalField, string][]) {
      const given = update[field];
      if (given === undefined) continue;
      const value = given?.trim() ?? "";
      const shown = names.get(value.toLowerCase());
      set[field] =
        value === ""
          ? null
          : shown === undefined
            ? await this.values.protect(value, kind, playerId)
            : await this.values.readable(shown, kind);
    }
    let location: PersonalState["location"] | null | undefined;
    if (update.location === null) location = null;
    else if (update.location !== undefined) {
      const kept = this.samePlace(before.location?.placeholder, update.location);
      location =
        kept !== undefined && before.location !== undefined
          ? {
              ...before.location,
              // Kept before coordinates had values of their own.
              ...(before.location.latitude === undefined
                ? await this.coordinates(
                    coordinatesIn(this.value(kept) ?? "") ?? update.location,
                    playerId,
                  )
                : {}),
              at: this.now(),
            }
          : {
              placeholder: await this.values.protect(
                locationText(update.location),
                "LOCATION",
                playerId,
              ),
              ...(await this.coordinates(update.location, playerId)),
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
    const old = before.location;
    if (old !== undefined && location !== undefined && location?.placeholder !== old.placeholder) {
      for (const placeholder of [old.placeholder, old.latitude, old.longitude])
        if (placeholder !== undefined && this.values.entry(placeholder)?.owner === playerId)
          await this.values.forget(placeholder);
    }
    // Rooms show whose location the model knows: one known or forgotten changes that.
    const known = location === undefined ? before.location !== undefined : location !== null;
    if ((before.location !== undefined) !== known) this.changed(playerId);
    return (await this.get(playerId, context))!;
  }

  /**
   * The coordinates as values of their own, to the same four decimals as the text, so a tool that
   * takes a latitude and a longitude, such as a weather service, gets numbers it can use.
   */
  private async coordinates(
    location: { latitude: number; longitude: number },
    playerId: string,
  ): Promise<{ latitude: string; longitude: string }> {
    return {
      latitude: await this.values.protect(location.latitude.toFixed(4), "LATITUDE", playerId),
      longitude: await this.values.protect(location.longitude.toFixed(4), "LONGITUDE", playerId),
    };
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
 * to someone else, and not in side conversations, which talk to people outside. In a shared room's
 * other turns, only where the members who chose to share it there are.
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
    const read = (playerId: string) => input.read.snapshot(PersonalDoc, playerId, context);
    const locationLine = async (state: PersonalState, playerId: string) => {
      const location = state.location;
      if (location === undefined || !known(location.placeholder)) return undefined;
      const profile = await input.read.snapshot(ProfileDoc, playerId, context);
      const at = formatAt(location.at, profile?.timeZone ?? timeZone);
      const { latitude, longitude } = location;
      const coordinates =
        latitude !== undefined && longitude !== undefined && known(latitude) && known(longitude)
          ? `latitude ${latitude}, longitude ${longitude}; `
          : "";
      return `${location.placeholder} (${coordinates}as of ${at})`;
    };

    const playerId =
      room.kind === "personal"
        ? room.members[0]
        : (await turn(input.conversationId, context)).privateTo?.playerId;
    const player = playerId === undefined ? undefined : directory?.players[playerId];
    if (player === undefined) {
      const lines: string[] = [];
      for (const id of await sharersOf(directory, room.id, read)) {
        const state = await read(id);
        const line = state === undefined ? undefined : await locationLine(state, id);
        const name = directory?.players[id]?.displayName;
        if (line !== undefined && name !== undefined) lines.push(`- ${name}: ${line}`);
      }
      if (lines.length === 0) return undefined;
      return [
        `Where people here are now, as each chose to share it in this room, for what is near ` +
          `them, the weather or the way somewhere. The values are kept from you: write the ` +
          `placeholders as they are, and tools get the real values. Use them only for that.`,
        ...lines,
      ].join("\n");
    }

    const state = await read(player.id);
    if (state === undefined) return undefined;
    const lines: string[] = [];
    for (const field of Object.keys(PERSONAL_FIELDS) as PersonalField[]) {
      const placeholder = state[field];
      if (placeholder !== undefined && known(placeholder))
        lines.push(`- ${LABELS[field]}: ${placeholder}`);
    }
    const location = await locationLine(state, player.id);
    if (location !== undefined) lines.push(`- Where they are now: ${location}`);
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

/**
 * The members whose location the model may know in a room: a personal room's owner once one is
 * known, and in a shared room those who chose to share it there. The lobby has none.
 */
async function sharersOf(
  directory: DirectoryState | undefined,
  roomId: string,
  read: (playerId: string) => Promise<PersonalState | undefined>,
): Promise<string[]> {
  const room = directory?.rooms[roomId];
  if (room === undefined) return [];
  if (room.kind === "personal") {
    const owner = room.members[0];
    return owner !== undefined && (await read(owner))?.location !== undefined ? [owner] : [];
  }
  if (room.kind !== "shared") return [];
  const sharers: string[] = [];
  for (const member of room.members)
    if ((await read(member))?.rooms?.includes(roomId)) sharers.push(member);
  return sharers;
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
