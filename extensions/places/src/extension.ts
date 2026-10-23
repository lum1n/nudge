import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  currentTurn,
  defineNudgeExtension,
  defineTool,
  DirectoryDoc,
  distanceMeters,
  type ExtensionRoute,
  FIRE_ENTRY,
  type FireEntryData,
  type Geo,
  type GeoPlace,
  type GeoPoint,
  GeoUnavailable,
  keepsPlaceholders,
  type LocationUpdate,
  type Nudge,
  type Owner,
  PersonalDoc,
  providedGeo,
  roomOf,
  section,
  type TravelMode,
  turnOf,
  Type,
} from "@nudge/core";
import { kindOf } from "./kinds.ts";
import {
  admit,
  DEFAULT_RADIUS,
  emptyPlaces,
  type FoundPlace,
  nameOf,
  placeRegion,
  PlacesDoc,
  type PlayerPlaces,
  regionsAt,
  type Reminder,
  remindersFor,
  type SavedPlace,
  SHOP_RADIUS,
  type Target,
} from "./model.ts";

const VERSION = "0.1.0";
const NAME = "places";

const Settings = Type.Object({
  maxPerHour: Type.Number({
    default: 6,
    minimum: 1,
    description: "Most reminders one person gets an hour from getting somewhere.",
  }),
  maxPlaces: Type.Number({ default: 30, minimum: 1, description: "Most places one person saves." }),
  regions: Type.Number({
    default: 19,
    minimum: 1,
    maximum: 99,
    description:
      "Most places a phone watches at once; iPhones watch 20, one of which tells it to ask again.",
  }),
  searchKm: Type.Number({
    default: 3,
    minimum: 0.5,
    description: "How far around someone to look for a place of a kind, such as a grocery store.",
  }),
});

/** A location older than this doesn't say where someone is now. */
const FRESH = 2 * 3_600_000;
/** Steps of a route this close to someone's own places are left out, so the way home isn't told. */
const PRIVATE_METERS = 500;
const MAX_RESULTS = 40;

export type PlacesExtensionOptions = {
  /** The map service; default the one the server runs (`provideGeo`). */
  readonly geo?: Geo;
};

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  ...(isError ? { isError } : {}),
});

function distance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}

function duration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** What a place of a kind is called for the model, by its tag: `shop:supermarket` → "supermarket". */
function kindName(tag: string | undefined): string | undefined {
  return tag?.split(":")[1]?.replace(/_/gu, " ");
}

/** Who a tool acts for: whoever sent the message, or whose private turn it is. */
function actor(): Owner | undefined {
  const { by, privateTo } = currentTurn();
  return by ?? privateTo;
}

/** Who something made now is private to, if the turn is private. */
function privately(): { privateTo?: Owner } {
  const { privateTo } = currentTurn();
  return privateTo === undefined ? {} : { privateTo: { ...privateTo } };
}

/** The region id a device watches a place of a kind under. */
function regionOf(place: GeoPlace): string {
  return `k:${place.id ?? `${place.latitude.toFixed(5)},${place.longitude.toFixed(5)}`}`;
}

function visible(reminder: Reminder, playerId: string | undefined): boolean {
  return reminder.privateTo === undefined || reminder.privateTo.playerId === playerId;
}

export function createPlacesExtension(options: PlacesExtensionOptions = {}) {
  return defineNudgeExtension({
    name: NAME,
    version: VERSION,
    description:
      "Places: reminders when you get somewhere, and addresses and routes from the server's own map service. The model sees places as ⟦PLACE:home⟧, never addresses or coordinates.",
    settings: Settings,
    setup: (host) => {
      const { maxPerHour, maxPlaces, regions: budget, searchKm } = host.settings;
      const geo = (): Geo => {
        const service = options.geo ?? providedGeo();
        if (service === undefined)
          throw new GeoUnavailable(
            "This assistant's host has no map: places by address, finding places and routes don't work here",
          );
        return service;
      };

      /**
       * What to say when the map found nothing near `point`: that it doesn't cover it yet, and is
       * fetching it, where the map follows people (ADR 17).
       */
      const coverage = async (point: GeoPoint | undefined): Promise<string> => {
        const service = options.geo ?? providedGeo();
        if (point === undefined || service?.follow === undefined) return "";
        const covered = await service.follow(point).catch(() => "outside" as const);
        return covered === "fetching"
          ? " The server's map doesn't cover that area yet: it is fetching it now, which takes a few minutes to an hour. Say so, and try again later."
          : covered === "outside"
            ? " The server's map doesn't cover that area, and won't fetch it (an owner can add it under the server's Maps settings)."
            : "";
      };
      const nudge = (): Nudge => host.assistant();
      const read = async (playerId: string, context: Context): Promise<PlayerPlaces> =>
        (await host.documents().snapshot(PlacesDoc, playerId, context)) ?? emptyPlaces();
      const change = <T>(
        playerId: string,
        context: Context,
        edit: (state: PlayerPlaces) => T | Promise<T>,
      ): Promise<T> =>
        host
          .documents()
          .commit(async (tx) => edit(await tx.doc(PlacesDoc, playerId, null)), context);

      /** Where the player's device last said they are, if lately. */
      const whereNow = async (
        playerId: string,
        context: Context,
      ): Promise<GeoPoint | undefined> => {
        const location = (await host.documents().snapshot(PersonalDoc, playerId, context))
          ?.location;
        if (location?.latitude === undefined || location.longitude === undefined) return undefined;
        if (host.now() - location.at > FRESH) return undefined;
        const latitude = Number(nudge().showTo(playerId, location.latitude));
        const longitude = Number(nudge().showTo(playerId, location.longitude));
        return Number.isFinite(latitude) && Number.isFinite(longitude)
          ? { latitude, longitude }
          : undefined;
      };

      /** The saved place `ref` names, by its name, what people call it, or its placeholder. */
      const savedPlace = (state: PlayerPlaces, ref: string): SavedPlace | undefined => {
        const trimmed = ref.trim();
        return state.places.find(
          (place) => place.placeholder === trimmed || place.name === nameOf(trimmed),
        );
      };

      /** A place of a kind's placeholder, put in the vault the first time the model hears of it. */
      const placeholderOf = async (found: FoundPlace, playerId: string): Promise<string> => {
        if (found.placeholder !== undefined) return found.placeholder;
        const value =
          found.address ??
          `${found.name} (${found.latitude.toFixed(4)}, ${found.longitude.toFixed(4)})`;
        return nudge().protectNamed(value, "PLACE", nameOf(found.name), playerId);
      };

      const foundOf = (place: GeoPlace): FoundPlace => ({
        name: place.name ?? place.address ?? "a place",
        tag: place.tag ?? "",
        latitude: place.latitude,
        longitude: place.longitude,
        ...(place.address === undefined ? {} : { address: place.address }),
      });

      /**
       * Saves a place for the player under `label`: at `point`, with `address` hidden as its
       * placeholder. One with the same name moves.
       */
      const save = async (
        player: Owner,
        label: string,
        point: GeoPoint,
        address: string,
        context: Context,
        radius = DEFAULT_RADIUS,
      ): Promise<SavedPlace> => {
        const name = nameOf(label);
        const state = await read(player.playerId, context);
        const old = state.places.find((place) => place.name === name);
        if (old === undefined && state.places.length >= maxPlaces)
          throw new Error(`You have ${maxPlaces} places saved already; forget one first`);
        // Someone else's home is theirs: this one's is "bo-home".
        const taken = nudge().valuesIn(`⟦PLACE:${name}⟧`)[0];
        const preferred =
          taken !== undefined && taken.owner !== player.playerId
            ? `${nameOf(player.displayName)}-${name}`.slice(0, 20).replace(/-+$/u, "")
            : name;
        if (old !== undefined) await nudge().forgetValue(old.placeholder, { admin: true });
        const placeholder = await nudge().protectNamed(
          address,
          "PLACE",
          preferred,
          player.playerId,
        );
        const place: SavedPlace = {
          name,
          placeholder,
          latitude: point.latitude,
          longitude: point.longitude,
          radius,
          createdAt: host.now(),
        };
        await change(player.playerId, context, (state) => {
          state.places = [...state.places.filter((p) => p.name !== name), structuredClone(place)];
          state.version += 1;
        });
        return place;
      };

      /** Finds an address or place with the map service, near the player when it knows where they are. */
      const lookUp = async (query: string, playerId: string, context: Context) => {
        const near = await whereNow(playerId, context);
        const [first] = await geo().search(nudge().showTo(playerId, query), {
          limit: 1,
          ...(near === undefined ? {} : { near }),
        });
        return first;
      };

      const savePlace = defineTool({
        name: "save_place",
        description:
          'Save a place for the person you are talking to under a name, such as "home", "work" or ' +
          '"Mum\'s", so you can remind them when they get there or work out routes. Its address ' +
          "and where it is are kept from you: you get a placeholder such as ⟦PLACE:home⟧.",
        parameters: Type.Object({
          name: Type.String({ description: 'What they call it, such as "home".' }),
          address: Type.String({
            description:
              'The address or place, as they gave it or as a placeholder; "here" for where they are now.',
          }),
        }),
        execute: async (args, _api, context) => {
          const player = actor();
          if (player === undefined) return text("Only a person can save a place.", true);
          const state = await read(player.playerId, context);
          const given = args.address.trim();
          let point: GeoPoint | undefined;
          let address: string | undefined;
          const result = state.results[given] ?? savedFound(state, given);
          if (/^(here|her)$/iu.test(given)) {
            point = await whereNow(player.playerId, context);
            if (point === undefined)
              return text(
                "I don't know where they are now: their phone shares it while the Nudge app is open, with Share where I am on.",
                true,
              );
            address = (
              await geo()
                .reverse(point)
                .catch(() => undefined)
            )?.address;
            address ??= `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`;
          } else if (result !== undefined) {
            point = result;
            address = result.address ?? result.name;
          } else {
            const found = await lookUp(given, player.playerId, context);
            if (found === undefined)
              return text(
                `The map doesn't know "${given}".${await coverage(await whereNow(player.playerId, context))}`,
                true,
              );
            point = found;
            address = found.address ?? found.name ?? nudge().showTo(player.playerId, given);
            // What they wrote stays theirs too, wherever they write it again.
            const written = nudge().showTo(player.playerId, given);
            if (written.length >= 2 && !written.includes("⟦"))
              await nudge().protect(written, "PLACE", { owner: player.playerId });
          }
          const place = await save(player, args.name, point, address, context);
          return text(
            `Saved "${args.name.trim()}" as ${place.placeholder}. Write it like that: they see the address, you never do.`,
          );
        },
      });

      /** A place `find_place` gave, by its placeholder, from an earlier save of it. */
      const savedFound = (state: PlayerPlaces, ref: string): FoundPlace | undefined =>
        Object.values(state.results).find((found) => found.placeholder === ref.trim());

      const listPlaces = defineTool({
        name: "list_places",
        description: "List the places the person you are talking to saved, by placeholder.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, _api, context) => {
          const player = actor();
          if (player === undefined) return text("Only a person has places.", true);
          const state = await read(player.playerId, context);
          if (state.places.length === 0) return text("No places saved.");
          return text(
            state.places
              .map((place) => `- ${place.name}: ${place.placeholder} (within ${place.radius} m)`)
              .join("\n"),
          );
        },
      });

      const forgetPlace = defineTool({
        name: "forget_place",
        description:
          "Forget one of the places the person you are talking to saved, and the reminders for it.",
        parameters: Type.Object({
          place: Type.String({ description: "Its name or placeholder." }),
        }),
        execute: async (args, _api, context) => {
          const player = actor();
          if (player === undefined) return text("Only a person has places.", true);
          const place = savedPlace(await read(player.playerId, context), args.place);
          if (place === undefined) return text(`No saved place "${args.place}".`, true);
          const dropped = await change(player.playerId, context, (state) => {
            const before = state.reminders.length;
            state.places = state.places.filter((p) => p.name !== place.name);
            state.reminders = state.reminders.filter(
              (r) => !("place" in r.target && r.target.place === place.name),
            );
            state.inside = state.inside.filter((id) => id !== placeRegion(place.name));
            state.version += 1;
            return before - state.reminders.length;
          });
          await nudge().forgetValue(place.placeholder, { admin: true });
          return text(
            `Forgot ${place.name}` + (dropped === 0 ? "." : `, and ${dropped} reminders for it.`),
          );
        },
      });

      const findPlace = defineTool({
        name: "find_place",
        description:
          'Look up places or addresses on the server\'s own map, such as "Kiwi", "pharmacy" or ' +
          '"Oslo S", near the person you are talking to or near a place. You get names, kinds and ' +
          "distances, and a placeholder for each that routes, reminders and save_place take.",
        parameters: Type.Object({
          query: Type.String({
            description:
              "A name or address as they gave it, or a kind of place in English, such as " +
              '"grocery store" or "pharmacy", whatever language they speak.',
          }),
          near: Type.Optional(
            Type.String({
              description:
                'A saved place\'s name or placeholder, or "here"; default where they are.',
            }),
          ),
        }),
        execute: async (args, _api, context) => {
          const player = actor();
          if (player === undefined) return text("Only a person can look places up.", true);
          const state = await read(player.playerId, context);
          const ref = args.near?.trim();
          const anchor =
            ref === undefined || /^(here|her)$/iu.test(ref) ? undefined : savedPlace(state, ref);
          const near = anchor ?? (await whereNow(player.playerId, context));
          const from = anchor?.placeholder ?? (near === undefined ? undefined : "where they are");
          const kind = kindOf(args.query);
          const places =
            kind !== undefined && near !== undefined
              ? await geo().nearby(kind.tags, near, searchKm, 8)
              : await geo().search(nudge().showTo(player.playerId, args.query), {
                  limit: 8,
                  ...(near === undefined ? {} : { near }),
                });
          if (places.length === 0)
            return text(`Nothing found for "${args.query}".${await coverage(near)}`);
          const lines: string[] = [];
          const results: Record<string, FoundPlace> = {};
          for (const place of places) {
            const found = foundOf(place);
            const placeholder = await placeholderOf(found, player.playerId);
            results[placeholder] = { ...found, placeholder };
            const what = kindName(place.tag);
            const away =
              near === undefined || from === undefined
                ? ""
                : `, ${distance(distanceMeters(near, place))} from ${from}`;
            lines.push(
              `- ${place.name ?? "An address"}${what === undefined ? "" : ` (${what})`}${away}: ${placeholder}`,
            );
          }
          await change(player.playerId, context, (state) => {
            const kept = Object.entries({ ...state.results, ...results }).slice(-MAX_RESULTS);
            state.results = Object.fromEntries(kept);
          });
          return text(
            lines.join("\n") +
              "\nTheir addresses are kept from you; write the placeholders as they are.",
          );
        },
      });

      /** Where a route starts or ends, and whether it is one of the player's own places. */
      const endpoint = async (
        ref: string,
        playerId: string,
        context: Context,
      ): Promise<{ point: GeoPoint; label: string; own: boolean } | undefined> => {
        const state = await read(playerId, context);
        const trimmed = ref.trim();
        if (/^(here|her)$/iu.test(trimmed)) {
          const point = await whereNow(playerId, context);
          return point === undefined ? undefined : { point, label: "where they are", own: true };
        }
        const place = savedPlace(state, trimmed);
        if (place !== undefined) return { point: place, label: place.placeholder, own: true };
        const result = state.results[trimmed] ?? savedFound(state, trimmed);
        if (result !== undefined)
          return { point: result, label: result.placeholder ?? result.name, own: false };
        const found = await lookUp(trimmed, playerId, context);
        if (found === undefined) return undefined;
        return { point: found, label: found.name ?? trimmed, own: false };
      };

      const route = defineTool({
        name: "route",
        description:
          "How far and how long between two places by car, bike or on foot, with the main roads, " +
          'from the server\'s own map. Takes saved places, placeholders from find_place, "here" ' +
          "or an address. Public transport isn't covered.",
        parameters: Type.Object({
          from: Type.String(),
          to: Type.String(),
          mode: Type.Union([Type.Literal("foot"), Type.Literal("bike"), Type.Literal("car")], {
            default: "foot",
          }),
        }),
        replay: "safe",
        execute: async (args, _api, context) => {
          const player = actor();
          if (player === undefined) return text("Only a person can ask for a route.", true);
          const from = await endpoint(args.from, player.playerId, context);
          if (from === undefined) return text(`I can't place "${args.from}".`, true);
          const to = await endpoint(args.to, player.playerId, context);
          if (to === undefined) return text(`I can't place "${args.to}".`, true);
          const way = await geo().route(from.point, to.point, (args.mode ?? "foot") as TravelMode);
          // Near their own places the streets would tell where those are: those steps are left out.
          const state = await read(player.playerId, context);
          const own: GeoPoint[] = [
            ...state.places,
            ...(from.own ? [from.point] : []),
            ...(to.own ? [to.point] : []),
          ];
          const now = await whereNow(player.playerId, context);
          if (now !== undefined) own.push(now);
          const steps: string[] = [];
          for (const step of way.steps) {
            const hidden = own.some((point) => distanceMeters(point, step.at) < PRIVATE_METERS);
            const line = hidden
              ? undefined
              : `${step.text}${step.meters > 0 ? ` (${distance(step.meters)})` : ""}`;
            if (line === undefined) {
              if (steps.at(-1) !== "…") steps.push("…");
            } else steps.push(line);
          }
          return text(
            [
              `From ${from.label} to ${to.label} ${args.mode === "car" ? "by car" : args.mode === "bike" ? "by bike" : "on foot"}: ${duration(way.seconds)}, ${distance(way.meters)}.`,
              ...(steps.some((step) => step !== "…")
                ? ["The way:", ...steps.map((s) => `- ${s}`)]
                : []),
            ].join("\n"),
          );
        },
      });

      const remind = defineTool({
        name: "remind_on_arrival",
        description:
          "Remind the person you are talking to when they get to a place, or leave it, such as " +
          '"when I get home, remind me to water the plants" or "at any grocery store, remind me ' +
          'to buy milk". Their phone tells the server when they get there, with the Nudge app ' +
          "allowed to use their location all the time.",
        parameters: Type.Object({
          where: Type.String({
            description:
              'A saved place\'s name or placeholder, a placeholder from find_place, "here", an ' +
              "address, or a kind of place in English, whatever language they speak, such as " +
              '"grocery store", "pharmacy", "post office" or "petrol station".',
          }),
          message: Type.String({ description: "What to remind them of, with every detail." }),
          on: Type.Optional(
            Type.Union([Type.Literal("arrive"), Type.Literal("leave")], { default: "arrive" }),
          ),
          repeat: Type.Optional(
            Type.Union([Type.Literal("once"), Type.Literal("always")], {
              default: "once",
              description: '"always" reminds them every time, an hour apart at least.',
            }),
          ),
          name: Type.Optional(
            Type.String({ description: 'What to save a new place as, such as "the gym".' }),
          ),
        }),
        execute: async (args, api, context) => {
          const player = actor();
          if (player === undefined) return text("Only a person can be reminded somewhere.", true);
          const message = args.message.trim();
          if (message === "") return text("Say what to remind them of.", true);
          const room = await roomOf(api, api.conversationId, context);
          const state = await read(player.playerId, context);
          const where = args.where.trim();
          let target: Target;
          let label: string;
          let saved = "";
          const place = savedPlace(state, where);
          const kind = place === undefined ? kindOf(where) : undefined;
          if (place !== undefined) {
            target = { place: place.name };
            label = place.placeholder;
          } else if (kind !== undefined) {
            target = { kind: kind.name, tags: [...kind.tags] };
            label = `any ${kind.name}`;
          } else {
            const result = state.results[where] ?? savedFound(state, where);
            let point: GeoPoint | undefined;
            let address: string | undefined;
            let named = args.name?.trim();
            if (/^(here|her)$/iu.test(where)) {
              point = await whereNow(player.playerId, context);
              if (point === undefined)
                return text(
                  "I don't know where they are now; their phone hasn't said lately.",
                  true,
                );
              address = (
                await geo()
                  .reverse(point)
                  .catch(() => undefined)
              )?.address;
              named ??= "spot";
            } else if (result !== undefined) {
              point = result;
              address = result.address;
              named ??= result.name;
            } else {
              const found = await lookUp(where, player.playerId, context);
              if (found === undefined)
                return text(
                  `The map doesn't know "${where}", and it isn't a saved place.${await coverage(await whereNow(player.playerId, context))}`,
                  true,
                );
              point = found;
              address = found.address;
              named ??= found.name ?? where;
            }
            address ??= `${named} (${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)})`;
            const made = await save(player, named, point, address, context);
            target = { place: made.name };
            label = made.placeholder;
            saved = ` It is saved as the place "${made.name}".`;
          }
          const on = args.on ?? "arrive";
          const reminder = await change(player.playerId, context, (state) => {
            const reminder: Reminder = {
              id: `a${state.next}`,
              roomId: room.id,
              target,
              on,
              message,
              repeat: args.repeat ?? "once",
              createdAt: host.now(),
              ...privately(),
              fired: 0,
            };
            state.next += 1;
            state.reminders.push(structuredClone(reminder));
            state.version += 1;
            return reminder;
          });
          return text(
            `Reminder ${reminder.id}: on ${on === "arrive" ? "getting to" : "leaving"} ${label}, ` +
              `${reminder.repeat === "always" ? "every time" : "once"}.${saved} Their phone needs ` +
              "the Nudge app with location allowed all the time, and Reminders when I arrive on.",
          );
        },
      });

      const describe = (reminder: Reminder, places: readonly SavedPlace[]) => {
        const target = reminder.target;
        const where =
          "place" in target
            ? (places.find((p) => p.name === target.place)?.placeholder ?? target.place)
            : `any ${target.kind}`;
        return (
          `${reminder.id}: on ${reminder.on === "arrive" ? "getting to" : "leaving"} ${where}` +
          `${reminder.repeat === "always" ? ", every time" : ""}: ${reminder.message}`
        );
      };

      const listReminders = defineTool({
        name: "list_arrival_reminders",
        description: "List the reminders of the person you are talking to for getting somewhere.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, _api, context) => {
          const player = actor();
          if (player === undefined) return text("Only a person has reminders.", true);
          const state = await read(player.playerId, context);
          const mine = state.reminders.filter((r) => visible(r, currentTurn().privateTo?.playerId));
          if (mine.length === 0) return text("No reminders for getting somewhere.");
          return text(mine.map((r) => `- ${describe(r, state.places)}`).join("\n"));
        },
      });

      const cancel = defineTool({
        name: "cancel_arrival_reminder",
        description: "Cancel one of their reminders for getting somewhere, by its id.",
        parameters: Type.Object({
          id: Type.String({ description: "From list_arrival_reminders." }),
        }),
        execute: async (args, _api, context) => {
          const player = actor();
          if (player === undefined) return text("Only a person has reminders.", true);
          const cancelled = await change(player.playerId, context, (state) => {
            const found = state.reminders.find((r) => r.id === args.id.trim());
            if (found === undefined || !visible(found, currentTurn().privateTo?.playerId))
              return false;
            state.reminders = state.reminders.filter((r) => r.id !== found.id);
            state.version += 1;
            return true;
          });
          return cancelled
            ? text(`Cancelled reminder ${args.id}.`)
            : text(`No reminder ${args.id}.`, true);
        },
      });

      /**
       * Says the reminder in its room: privately, unless the room is the player's own or they let
       * the model know where they are there (ADR 14), since it tells the room where they are.
       */
      const fire = async (
        playerId: string,
        reminder: Reminder,
        region: string,
        context: Context,
      ): Promise<boolean> => {
        const assistant = nudge();
        if (!(await assistant.extensionEnabled(reminder.roomId, NAME, context))) return false;
        const player = await assistant.players.get(playerId, context);
        const room = await assistant.rooms.get(reminder.roomId, context);
        if (player === undefined || room === undefined || !room.members.includes(playerId))
          return false;
        const now = host.now();
        const state = await read(playerId, context);
        let where: string;
        const target = reminder.target;
        if ("place" in target) {
          where = state.places.find((p) => p.name === target.place)?.placeholder ?? target.place;
        } else {
          const found = state.found[region];
          if (found === undefined) return false;
          const placeholder = await placeholderOf(found, playerId);
          where = `a ${target.kind}, ${found.name} (${placeholder})`;
          await change(playerId, context, (state) => {
            const kept = state.found[region];
            if (kept !== undefined) kept.placeholder = placeholder;
          });
        }
        const count = await change(playerId, context, (state) => {
          const item = state.reminders.find((r) => r.id === reminder.id);
          if (item === undefined) return undefined;
          const recent = admit(state.recent, now, maxPerHour);
          if (recent === undefined) return undefined;
          state.recent = recent;
          item.fired += 1;
          item.lastFiredAt = now;
          const count = item.fired;
          if (item.repeat === "once") {
            state.reminders = state.reminders.filter((r) => r.id !== item.id);
            state.version += 1;
          }
          return count;
        });
        if (count === undefined) return false;
        const owner = { playerId, displayName: player.displayName };
        const shares =
          room.kind === "personal" ||
          (await assistant.personal.sharingIn(room.id, context)).includes(playerId);
        const privateTo = reminder.privateTo ?? (shares ? undefined : owner);
        const conversation = await assistant.conversation(room.id, context);
        await conversation.submit(
          {
            type: "input",
            content:
              `${player.displayName} just ${reminder.on === "arrive" ? "got to" : "left"} ${where}. ` +
              `They asked to be reminded then: ${reminder.message}\nRemind them now, in a line or two.` +
              (privateTo === undefined
                ? ""
                : ` Only ${player.displayName} sees it and your answer: don't tell the others where they are.`),
            whenBusy: "followUp",
            requestId: `arrival:${playerId}:${reminder.id}:${count}`,
            entry: {
              kind: FIRE_ENTRY,
              data: {
                nudgeId: `arrival-${reminder.id}`,
                message: reminder.message,
                fireAt: now,
                source: "arrival",
                ...(privateTo === undefined ? {} : { privateTo }),
              } satisfies FireEntryData,
            },
          },
          context,
        );
        return true;
      };

      /** A device or a location says the player got to or left a region. */
      const crossed = async (
        playerId: string,
        region: string,
        event: "enter" | "exit",
        context: Context,
      ): Promise<number> => {
        await change(playerId, context, (state) => {
          const inside = new Set(state.inside);
          if (event === "enter") inside.add(region);
          else inside.delete(region);
          state.inside = [...inside];
        });
        let fired = 0;
        for (const reminder of remindersFor(
          await read(playerId, context),
          region,
          event,
          host.now(),
        ))
          if (await fire(playerId, reminder, region, context)) fired += 1;
        return fired;
      };

      /** Where the player is, from the app or the web: the server's own check, besides the phone's. */
      const onLocation = async (playerId: string, location: LocationUpdate) => {
        const context = BACKGROUND_CONTEXT;
        const point = { latitude: location.latitude, longitude: location.longitude };
        // The map follows people wherever they go, so places and routes work there too.
        void (options.geo ?? providedGeo())?.follow?.(point).catch(() => {});
        let state = await read(playerId, context);
        if (state.reminders.length === 0 && state.inside.length === 0) return;
        const tags = [
          ...new Set(state.reminders.flatMap((r) => ("tags" in r.target ? r.target.tags : []))),
        ];
        const service = options.geo ?? providedGeo();
        if (tags.length > 0 && service !== undefined) {
          const near = await service.nearby(tags, point, 0.3, 5).catch(() => []);
          if (near.length > 0) {
            await change(playerId, context, (state) => {
              for (const place of near) state.found[regionOf(place)] ??= foundOf(place);
              state.found = Object.fromEntries(Object.entries(state.found).slice(-MAX_RESULTS));
            });
            state = await read(playerId, context);
          }
        }
        const now = new Set(regionsAt(state, point));
        const was = new Set(state.inside);
        for (const region of now)
          if (!was.has(region)) await crossed(playerId, region, "enter", context);
        for (const region of was)
          if (!now.has(region)) await crossed(playerId, region, "exit", context);
      };

      /** Only where the player lives: guests' homes keep where they are (ADR 14). */
      const homeOnly = (caller: { player?: { home?: unknown } }) =>
        caller.player === undefined || caller.player.home !== undefined
          ? Response.json(
              { error: "Where you are and your places stay at your home assistant" },
              { status: 403 },
            )
          : undefined;

      const regionsRoute: ExtensionRoute = {
        method: "GET",
        path: "/regions",
        auth: "player",
        handle: async (request, caller) => {
          const refused = homeOnly(caller);
          if (refused !== undefined) return refused;
          const playerId = caller.player!.id;
          const context = caller.context;
          const url = new URL(request.url);
          const latitude = Number(url.searchParams.get("lat"));
          const longitude = Number(url.searchParams.get("lon"));
          const point =
            url.searchParams.has("lat") &&
            Number.isFinite(latitude) &&
            Number.isFinite(longitude) &&
            Math.abs(latitude) <= 90 &&
            Math.abs(longitude) <= 180
              ? { latitude, longitude }
              : undefined;
          // Where the phone is, so the map has the shops there by the time they are wanted.
          if (point !== undefined)
            void (options.geo ?? providedGeo())?.follow?.(point).catch(() => {});
          const state = await read(playerId, context);
          const wanted = new Set(
            state.reminders.flatMap((r) => ("place" in r.target ? [r.target.place] : [])),
          );
          const regions = state.places
            .filter((place) => wanted.has(place.name))
            .map((place) => ({
              id: placeRegion(place.name),
              latitude: place.latitude,
              longitude: place.longitude,
              radius: place.radius,
            }))
            .slice(0, budget);
          const tags = [
            ...new Set(state.reminders.flatMap((r) => ("tags" in r.target ? r.target.tags : []))),
          ];
          let refresh: { latitude: number; longitude: number; radius: number } | undefined;
          if (tags.length > 0 && point !== undefined && regions.length < budget) {
            const service = options.geo ?? providedGeo();
            const near =
              service === undefined
                ? []
                : await service
                    .nearby(tags, point, searchKm, budget - regions.length)
                    .catch(() => []);
            const found: Record<string, FoundPlace> = {};
            for (const place of near) {
              const id = regionOf(place);
              found[id] = state.found[id] ?? foundOf(place);
              regions.push({
                id,
                latitude: place.latitude,
                longitude: place.longitude,
                radius: SHOP_RADIUS,
              });
            }
            await change(playerId, context, (state) => {
              state.found = found;
            });
            // Asked again once they leave the circle the found places are in.
            const farthest = Math.max(0, ...near.map((place) => distanceMeters(point, place)));
            refresh = {
              ...point,
              radius: Math.round(Math.max(500, Math.min(searchKm * 1000, farthest) * 0.75)),
            };
          }
          return Response.json({
            version: state.version,
            regions,
            ...(refresh === undefined ? {} : { refresh }),
          });
        },
      };

      const eventsRoute: ExtensionRoute = {
        method: "POST",
        path: "/events",
        auth: "player",
        handle: async (request, caller) => {
          const refused = homeOnly(caller);
          if (refused !== undefined) return refused;
          const body = (await request.json().catch(() => undefined)) as
            | { regionId?: unknown; event?: unknown }
            | undefined;
          const region = body?.regionId;
          const event = body?.event;
          if (typeof region !== "string" || (event !== "enter" && event !== "exit"))
            return Response.json(
              { error: 'Send { "regionId": "<id>", "event": "enter" | "exit" }' },
              { status: 400 },
            );
          const fired = await crossed(caller.player!.id, region, event, caller.context);
          return Response.json({ fired });
        },
      };

      const placesRoute: ExtensionRoute = {
        method: "GET",
        path: "/places",
        auth: "player",
        handle: async (_request, caller) => {
          const refused = homeOnly(caller);
          if (refused !== undefined) return refused;
          const playerId = caller.player!.id;
          const state = await read(playerId, caller.context);
          return Response.json({
            places: state.places.map((place) => ({
              name: place.name,
              placeholder: place.placeholder,
              address: nudge().showTo(playerId, place.placeholder),
              radius: place.radius,
            })),
            reminders: state.reminders.map((reminder) => ({
              id: reminder.id,
              roomId: reminder.roomId,
              on: reminder.on,
              repeat: reminder.repeat,
              ...("place" in reminder.target
                ? { place: reminder.target.place }
                : { kind: reminder.target.kind }),
              message: nudge().showTo(playerId, reminder.message),
            })),
          });
        },
      };

      const forgetPlaceRoute: ExtensionRoute = {
        method: "DELETE",
        path: "/places/:name",
        auth: "player",
        handle: async (_request, caller) => {
          const refused = homeOnly(caller);
          if (refused !== undefined) return refused;
          const playerId = caller.player!.id;
          const place = savedPlace(await read(playerId, caller.context), caller.params.name ?? "");
          if (place === undefined)
            return Response.json({ error: "No such place" }, { status: 404 });
          await change(playerId, caller.context, (state) => {
            state.places = state.places.filter((p) => p.name !== place.name);
            state.reminders = state.reminders.filter(
              (r) => !("place" in r.target && r.target.place === place.name),
            );
            state.version += 1;
          });
          await nudge().forgetValue(place.placeholder, { admin: true });
          return new Response(null, { status: 204 });
        },
      };

      const cancelRoute: ExtensionRoute = {
        method: "DELETE",
        path: "/reminders/:id",
        auth: "player",
        handle: async (_request, caller) => {
          const refused = homeOnly(caller);
          if (refused !== undefined) return refused;
          const id = caller.params.id ?? "";
          const cancelled = await change(caller.player!.id, caller.context, (state) => {
            const before = state.reminders.length;
            state.reminders = state.reminders.filter((r) => r.id !== id);
            if (state.reminders.length !== before) state.version += 1;
            return state.reminders.length !== before;
          });
          return cancelled
            ? new Response(null, { status: 204 })
            : Response.json({ error: "No such reminder" }, { status: 404 });
        },
      };

      return {
        // Places and messages are kept as the model wrote them, placeholders and all.
        tools: [
          keepsPlaceholders(savePlace),
          listPlaces,
          keepsPlaceholders(forgetPlace),
          keepsPlaceholders(findPlace),
          keepsPlaceholders(route),
          keepsPlaceholders(remind),
          listReminders,
          cancel,
        ],
        routes: [regionsRoute, eventsRoute, placesRoute, forgetPlaceRoute, cancelRoute],
        onLocation,
        sections: [
          section("places", async (input, context) => {
            const directory = await input.read.snapshot(DirectoryDoc, context);
            // Side conversations talk to people outside.
            if (directory?.sides?.[String(input.conversationId)] !== undefined) return undefined;
            const room = await roomOf(input.read, input.conversationId, context).catch(
              () => undefined,
            );
            if (room === undefined) return undefined;
            const playerId =
              room.kind === "personal"
                ? room.members[0]
                : (await turnOf(nudge().harness, input.conversationId, context)).privateTo
                    ?.playerId;
            const player = playerId === undefined ? undefined : directory?.players[playerId];
            if (player !== undefined) {
              const state = await read(player.id, context);
              if (state.places.length === 0 && state.reminders.length === 0) return undefined;
              const lines = [
                `Places ${player.displayName} saved (their addresses are kept from you; save_place, ` +
                  "find_place, route and remind_on_arrival take these placeholders as they are):",
                ...state.places.map((place) => `- ${place.name}: ${place.placeholder}`),
              ];
              const point = await whereNow(player.id, context);
              const at =
                point === undefined
                  ? undefined
                  : state.places.find((place) => distanceMeters(place, point) <= place.radius);
              if (at !== undefined) lines.push(`They are at ${at.placeholder} now.`);
              const reminders = state.reminders.filter((r) => r.roomId === room.id);
              if (reminders.length > 0)
                lines.push(
                  "Their reminders here for getting somewhere:",
                  ...reminders.map((r) => `- ${describe(r, state.places)}`),
                );
              return lines.join("\n");
            }
            // A shared room: what those who share where they are here set in the open.
            const lines: string[] = [];
            for (const member of await nudge().personal.sharingIn(room.id, context)) {
              const name = directory?.players[member]?.displayName;
              if (name === undefined) continue;
              const state = await read(member, context);
              const point = await whereNow(member, context);
              const at =
                point === undefined
                  ? undefined
                  : state.places.find((place) => distanceMeters(place, point) <= place.radius);
              if (at !== undefined) lines.push(`- ${name} is at their ${at.name} now.`);
              for (const r of state.reminders)
                if (r.roomId === room.id && r.privateTo === undefined)
                  lines.push(`- ${name}'s reminder ${describe(r, state.places)}`);
            }
            return lines.length === 0 ? undefined : ["Places:", ...lines].join("\n");
          }),
        ],
      };
    },
  });
}

export const placesExtension = createPlacesExtension();

export default placesExtension;
