import { defineDocFamily } from "@earendil-works/pi-durable";
import { distanceMeters, type GeoPoint } from "@nudge/core";

// Stored in a document, so plain JSON. Coordinates are kept here and nowhere the model reads.

/** A place someone saved by name, such as "home". */
export type SavedPlace = {
  /** What follows `⟦PLACE:` in its placeholder, before any `-2`; lower case, as people say it. */
  name: string;
  /** The address the vault keeps under it, as `⟦PLACE:home⟧`. */
  placeholder: string;
  latitude: number;
  longitude: number;
  /** Metres from the point that count as being there. */
  radius: number;
  createdAt: number;
};

/** What a reminder waits for: a saved place, or any place of a kind, such as a grocery store. */
export type Target = { place: string } | { kind: string; tags: string[] };

export type Reminder = {
  /** `a1`, `a2`, … per player. */
  id: string;
  roomId: string;
  target: Target;
  /** Getting there, or leaving. */
  on: "arrive" | "leave";
  /** What to remind them of, as the model wrote it, placeholders and all. */
  message: string;
  /** Once and done, or every time (an hour apart at least). */
  repeat: "once" | "always";
  createdAt: number;
  /** Set in answer to something private: the reminder and what it says are theirs alone. */
  privateTo?: { playerId: string; displayName: string };
  fired: number;
  lastFiredAt?: number;
};

/** A place of a kind the server found near someone, for the device to watch. */
export type FoundPlace = {
  /** Given once the model is told of it; the address stays in the vault. */
  placeholder?: string;
  /** Kept to put in the vault when it is. */
  address?: string;
  name: string;
  tag: string;
  latitude: number;
  longitude: number;
};

export type PlayerPlaces = {
  places: SavedPlace[];
  reminders: Reminder[];
  next: number;
  /** Places found by kind that devices watch now, by region id (`k:<id>`). */
  found: Record<string, FoundPlace>;
  /** What `find_place` last gave, by placeholder, so a reminder or route can name one. */
  results: Record<string, FoundPlace>;
  /** Regions the player was last known to be in, from their devices or where they said they are. */
  inside: string[];
  /** When reminders fired in the last hour, oldest first. */
  recent: number[];
  /** Goes up when what devices should watch changes. */
  version: number;
};

export function emptyPlaces(): PlayerPlaces {
  return {
    places: [],
    reminders: [],
    next: 1,
    found: {},
    results: {},
    inside: [],
    recent: [],
    version: 0,
  };
}

/** Each player's saved places and arrival reminders. */
export const PlacesDoc = defineDocFamily<PlayerPlaces, null>({
  kind: "places.player",
  version: 1,
  scope: "session",
  family: true,
  initial: emptyPlaces,
});

export const HOUR = 3_600_000;
/** Metres around a saved place that count as being there, unless it says otherwise. */
export const DEFAULT_RADIUS = 150;
/** Metres around a shop: they are smaller, and there may be one next door. */
export const SHOP_RADIUS = 80;
/** An "always" reminder fires again only after this long. */
export const COOLDOWN = HOUR;

/** The name a placeholder takes from what people call a place: "Mum's house" → `mums-house`. */
export function nameOf(label: string): string {
  const name = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/æ/gu, "ae")
    .replace(/ø/gu, "o")
    .replace(/å/gu, "a")
    .replace(/[̀-ͯ'’]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 16)
    .replace(/-+$/u, "");
  return name === "" ? "place" : name;
}

/** The region id a device watches a saved place under. */
export function placeRegion(name: string): string {
  return `p:${name}`;
}

/** The regions around `point`: saved places and found ones whose circles it is in. */
export function regionsAt(state: PlayerPlaces, point: GeoPoint): string[] {
  const inside: string[] = [];
  for (const place of state.places)
    if (distanceMeters(place, point) <= place.radius) inside.push(placeRegion(place.name));
  for (const [id, place] of Object.entries(state.found))
    if (distanceMeters(place, point) <= SHOP_RADIUS) inside.push(id);
  return inside;
}

/**
 * The reminders a region event sets off: arriving at or leaving a saved place, or a place of
 * their kind. "always" ones fire again once `COOLDOWN` has passed.
 */
export function remindersFor(
  state: PlayerPlaces,
  region: string,
  event: "enter" | "exit",
  now: number,
): Reminder[] {
  const on = event === "enter" ? "arrive" : "leave";
  const tag = state.found[region]?.tag;
  return state.reminders.filter((reminder) => {
    if (reminder.on !== on) return false;
    if (
      reminder.repeat === "always" &&
      reminder.lastFiredAt !== undefined &&
      now - reminder.lastFiredAt < COOLDOWN
    )
      return false;
    const target = reminder.target;
    return "place" in target
      ? placeRegion(target.place) === region
      : tag !== undefined && target.tags.includes(tag);
  });
}

/** Takes one firing against the limit of `max` an hour; false when there were `max` already. */
export function admit(recent: readonly number[], now: number, max: number): number[] | undefined {
  const kept = recent.filter((at) => at > now - HOUR);
  return kept.length >= max ? undefined : [...kept, now];
}
