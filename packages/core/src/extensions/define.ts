import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Extension, JsonObject, Session } from "@earendil-works/pi-durable";
import type { ApprovalHandler } from "../approvals/approvals.ts";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { ConfigError } from "../config.ts";
import type { Player, Room, RoomKind } from "../identity/directory.ts";
import { InvalidProfile } from "../identity/profiles.ts";
import type { PiiDetector } from "../privacy/detectors.ts";
import type { RoomEvent } from "../room-events.ts";
import type { Nudge } from "../nudge.ts";
import { SecretStore } from "../secrets.ts";

/** What an extension's `setup` gets from the assistant it is installed in. */
export type ExtensionHost<Settings, PlayerSettings = undefined> = {
  /** The extension's settings from the config, checked against its schema, defaults filled in. */
  readonly settings: Settings;
  /**
   * A player's settings for the extension from their profile, defaults filled in; the defaults
   * alone when they set none or what they set no longer fits the schema. Undefined for a player
   * who doesn't exist. Throws until the assistant is open.
   */
  readonly playerSettings: (
    playerId: string,
    context: Context,
  ) => Promise<PlayerSettings | undefined>;
  /** The assistant's name in URLs: `/v1/a/<name>`. */
  readonly name: string;
  /** What the assistant calls itself. */
  readonly displayName: string;
  readonly timeZone: string;
  readonly now: () => number;
  /** Keeps a value from the model from now on; see `Nudge.protect`. Usable once the assistant is open. */
  readonly protect: (value: string, kind?: string) => Promise<string>;
  /** A directory of the extension's own next to the assistant's database; absent when nothing is persisted. */
  readonly dataDir?: string;
  /** Keys and passwords the extension keeps for itself, encrypted at rest; never reaches the model. */
  readonly secrets: SecretStore;
  /**
   * The assistant's documents, for work outside tools and approvals, such as a room socket.
   * Throws until the assistant is open.
   */
  readonly documents: () => ExtensionDocuments;
  /**
   * The assistant itself, for what documents don't cover, such as posting a message as a player
   * or deciding an approval for one. Checking that the player may use the room is the caller's
   * job. Throws until the assistant is open.
   */
  readonly assistant: () => Nudge;
  /**
   * The assistant once it is open, such as to listen to its `changes`; at once for an extension
   * a reload sets up. Never settles when the assistant fails to open.
   */
  readonly whenOpen: () => Promise<Nudge>;
};

/** Reading, watching and changing the assistant's documents. */
export type ExtensionDocuments = Pick<Session, "snapshot" | "watchDoc" | "commit">;

/**
 * What the assistant gives every extension; `setUpExtension` adds the settings and each one's
 * `dataDir` and `secrets`.
 */
export type HostBase = Omit<
  ExtensionHost<unknown>,
  "settings" | "playerSettings" | "dataDir" | "secrets"
> & {
  /** Parent of the extensions' data directories. */
  readonly dataRoot?: string;
};

/** The server's side of one client connected to an extension's room socket. */
export type RoomSocket = {
  /** Sends one text frame to the client. */
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

/** What a room socket does with the client's frames after the server has let it in. */
export type RoomSocketSession = {
  receive(data: string): void;
  /** The client went away or the server is closing. */
  close(): void;
};

/**
 * Serves `WS /a/<assistant>/rooms/<room>/ext/<extension>`. The server has already checked the
 * client's token and that the player may use the room.
 */
export type RoomSocketHandler = (
  client: {
    readonly room: Room;
    readonly player: Player;
    /** Whether the player may use the admin API. */
    readonly admin: boolean;
  },
  socket: RoomSocket,
) => RoomSocketSession | Promise<RoomSocketSession>;

/** Who may call an extension's route: any player with a token, admins only, or anyone. */
export type RouteAuth = "player" | "admin" | "none";

/** Who called an extension's route, and what its path said. */
export type RouteCaller = {
  /** Absent for routes with `auth: "none"`. */
  readonly player?: Player;
  /** The client whose token called; absent with the player. */
  readonly clientId?: string;
  /** Whether the player may use the admin API; false without a player. */
  readonly admin: boolean;
  /** The path's `:name` parts, decoded. */
  readonly params: Readonly<Record<string, string>>;
  readonly context: Context;
};

/**
 * One HTTP route of an extension, served at `/v1/a/<assistant>/ext/<extension><path>`. The server
 * checks the token for `auth` and the body's size before `handle` runs.
 */
export type ExtensionRoute = {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Below the extension's prefix, such as `/key` or `/invites/:id`; `/` for the prefix itself. */
  readonly path: string;
  readonly auth: RouteAuth;
  /** Most bytes the request body may have; default 64 KiB. */
  readonly maxBodyBytes?: number;
  handle(request: Request, caller: RouteCaller): Response | Promise<Response>;
};

/** Default most bytes of an extension route's request body. */
export const MAX_ROUTE_BODY = 64 * 1024;

/** What `setup` returns: a Pi Durable extension without its name, and detectors for redaction. */
export type ExtensionParts = Omit<Extension, "name"> & {
  /** Personal data the extension knows how to find; they run after the assistant's own. */
  readonly detectors?: readonly PiiDetector[];
  /** A WebSocket per room for the extension's own client UI. */
  readonly roomSocket?: RoomSocketHandler;
  /** HTTP routes of its own, such as for other assistants or webhooks to call. */
  readonly routes?: readonly ExtensionRoute[];
  /** Models the extension calls itself, so `nudge doctor` can check their credentials. */
  readonly models?: readonly { readonly provider: string; readonly modelId: string }[];
  /**
   * What keeps the extension from working on this machine, such as programs it needs that are
   * missing, for `nudge doctor`; none when it can work.
   */
  readonly problems?: () => readonly string[] | Promise<readonly string[]>;
  /**
   * Runs actions people approved, by kind. The extension's tools ask with `requestApproval`
   * under the extension's name.
   */
  readonly approvals?: Readonly<Record<string, ApprovalHandler>>;
  /**
   * Hears about answers and approvals in the rooms the extension is on in, after they are
   * committed, such as to pass them on to a phone. Must not block; a throw or rejection is reported.
   */
  readonly onRoomEvent?: (event: RoomEvent) => void | Promise<void>;
  /**
   * Releases what `setup` started, such as processes or connections, once a reload replaced the
   * extension or the assistant closed. Calls that already started may still be finishing.
   */
  readonly close?: () => void | Promise<void>;
  /**
   * Runs once when the assistant is about to be deleted for good, such as to tell other
   * assistants it is gone. Best effort: the deletion goes on after a failure, or after
   * `RETIRE_TIMEOUT_MS`.
   */
  readonly retire?: (context: Context) => void | Promise<void>;
  /**
   * Which player here an assertion from another assistant names, once the extension checked it,
   * such as the home of an owner vouching for them (ADR 11); undefined when it can't tell. The
   * assertion is whatever the caller sent, unchecked.
   */
  readonly identify?: (assertion: unknown, context: Context) => Promise<string | undefined>;
};

export type NudgeExtension<S extends TSchema = TSchema, P extends TSchema = TSchema> = {
  readonly kind: "nudge.extension";
  /** Lower-case letters, digits and dashes. Installing another extension with this name replaces it. */
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  /** TypeBox schema of the settings; without one the extension takes none. */
  readonly settings?: S;
  /**
   * TypeBox schema of what each player chooses for themselves, kept in their profile and carried
   * to the other assistants they are in (ADR 10). Defaults alone must fit it, for players who
   * chose nothing.
   */
  readonly playerSettings?: P;
  /** Runs once per assistant at open, and again on every reload. */
  setup(host: ExtensionHost<Static<S>, Static<P>>): ExtensionParts | Promise<ExtensionParts>;
};

/** An extension and its settings, as the config gives them. */
export type ExtensionUse = {
  readonly extension: NudgeExtension | Extension;
  /** Only for Nudge extensions. */
  readonly settings?: unknown;
  /** The kinds of room it is on in unless a room says otherwise; default every kind. */
  readonly rooms?: readonly RoomKind[];
};

/** What `NudgeOptions.extensions` takes: a plain Pi Durable extension, a Nudge one, or one with settings. */
export type ExtensionInput = Extension | NudgeExtension | ExtensionUse;

const NAME = /^[a-z][a-z0-9-]*$/;

/** What `roomsSetting` marks its schema with, for settings forms to offer a choice of rooms. */
export const ROOMS_SETTING = "rooms";

/**
 * A setting that is a list of rooms, by id, with `*` for every room. Settings forms show it as
 * a choice among the assistant's rooms by name, so nobody has to know an id.
 */
export function roomsSetting(
  options: { readonly description?: string; readonly title?: string } = {},
) {
  return Type.Array(Type.String(), { minItems: 1, ...options, "x-nudge": ROOMS_SETTING });
}

/** The name the built-in extension uses; nothing else may take it. */
export const BUILTIN_NAME = "nudge";

export function defineNudgeExtension<S extends TSchema = TSchema, P extends TSchema = TSchema>(
  extension: Omit<NudgeExtension<S, P>, "kind">,
): NudgeExtension<S, P> {
  if (!NAME.test(extension.name))
    throw new Error(
      `Extension name "${extension.name}" is not lower-case letters, digits and dashes`,
    );
  if (extension.name === BUILTIN_NAME)
    throw new Error(`"${BUILTIN_NAME}" is the built-in extension`);
  const players = extension.playerSettings;
  if (players !== undefined && !Value.Check(players, Value.Default(players, {})))
    throw new Error(
      `The player settings of extension "${extension.name}" need a default for every required one`,
    );
  return { kind: "nudge.extension", ...extension };
}

export function isNudgeExtension(value: unknown): value is NudgeExtension {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "nudge.extension"
  );
}

export type SetUpExtension = {
  readonly extension: Extension;
  readonly version?: string;
  readonly description?: string;
  /** See `NudgeExtension.playerSettings`. */
  readonly playerSettings?: TSchema;
  /** Default every kind; see `ExtensionUse.rooms`. */
  readonly rooms?: readonly RoomKind[];
  readonly detectors: readonly PiiDetector[];
  readonly roomSocket?: RoomSocketHandler;
  readonly routes: readonly ExtensionRoute[];
  readonly models: readonly { readonly provider: string; readonly modelId: string }[];
  readonly problems?: () => readonly string[] | Promise<readonly string[]>;
  readonly approvals: Readonly<Record<string, ApprovalHandler>>;
  readonly onRoomEvent?: (event: RoomEvent) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
  readonly retire?: (context: Context) => void | Promise<void>;
  readonly identify?: (assertion: unknown, context: Context) => Promise<string | undefined>;
};

/** Checks the settings and runs `setup`. A plain extension passes through. */
export async function setUpExtension(
  input: ExtensionInput,
  host: HostBase,
): Promise<SetUpExtension> {
  const use: ExtensionUse = isNudgeExtension(input)
    ? { extension: input }
    : "extension" in input
      ? input
      : { extension: input };
  const rooms = use.rooms === undefined ? {} : { rooms: use.rooms };
  if (!isNudgeExtension(use.extension)) {
    const extension = use.extension;
    if (extension.name === BUILTIN_NAME)
      throw new Error(`"${BUILTIN_NAME}" is the built-in extension`);
    if (use.settings !== undefined)
      throw new ConfigError(
        `${extension.name} is a plain Pi Durable extension; it takes no settings`,
      );
    return { extension, detectors: [], routes: [], models: [], approvals: {}, ...rooms };
  }
  const definition = use.extension;
  const settings = checkSettings(definition, use.settings);
  const { dataRoot, ...base } = host;
  const dataDir = dataRoot === undefined ? undefined : join(dataRoot, definition.name);
  const schema = definition.playerSettings;
  const playerSettings = async (playerId: string, context: Context) => {
    const profile = await base.assistant().profiles.get(playerId, context);
    if (profile === undefined || schema === undefined) return undefined;
    return fillPlayerSettings(schema, profile.extensions?.[definition.name]);
  };
  const secrets = new SecretStore(dataDir === undefined ? undefined : join(dataDir, "secrets"));
  const {
    detectors = [],
    roomSocket,
    routes = [],
    models = [],
    problems,
    approvals = {},
    onRoomEvent,
    close,
    retire,
    identify,
    ...parts
  } = await definition.setup({
    ...base,
    settings,
    playerSettings,
    secrets,
    ...(dataDir === undefined ? {} : { dataDir }),
  });
  checkRoutes(definition.name, routes);
  return {
    extension: { ...parts, name: definition.name },
    version: definition.version,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(schema === undefined ? {} : { playerSettings: schema }),
    ...rooms,
    detectors,
    routes,
    models,
    approvals,
    ...(problems === undefined ? {} : { problems }),
    ...(roomSocket === undefined ? {} : { roomSocket }),
    ...(onRoomEvent === undefined ? {} : { onRoomEvent }),
    ...(close === undefined ? {} : { close }),
    ...(retire === undefined ? {} : { retire }),
    ...(identify === undefined ? {} : { identify }),
  };
}

function checkSettings(extension: NudgeExtension, settings: unknown): unknown {
  if (extension.settings === undefined) {
    if (settings !== undefined && !isEmptyObject(settings))
      throw new ConfigError(`Extension "${extension.name}" takes no settings`);
    return undefined;
  }
  const value = Value.Default(extension.settings, Value.Clone(settings ?? {}));
  if (!Value.Check(extension.settings, value)) {
    const problems = [...Value.Errors(extension.settings, value)]
      .slice(0, 5)
      .map((error) => `${error.instancePath || "/"} ${error.message}`);
    throw new ConfigError(
      `Invalid settings for extension "${extension.name}":\n  ${problems.join("\n  ")}`,
    );
  }
  return value;
}

const ROUTE_PATH = /^\/$|^(\/(:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9._~-]+))+$/;

function checkRoutes(extension: string, routes: readonly ExtensionRoute[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    if (!ROUTE_PATH.test(route.path))
      throw new Error(`Extension "${extension}" has a route with a bad path "${route.path}"`);
    // Two routes whose paths differ only in their params' names would shadow each other.
    const shape = `${route.method} ${route.path.replace(/:[^/]+/g, ":")}`;
    if (seen.has(shape))
      throw new Error(`Extension "${extension}" has two routes for ${route.method} ${route.path}`);
    seen.add(shape);
  }
}

/**
 * The route of `routes` for a request to `path` below the extension's prefix, and its params.
 * Fixed segments win over params, so `/invites/new` comes before `/invites/:id`.
 */
export function matchRoute(
  routes: readonly ExtensionRoute[],
  method: string,
  path: string,
): { route: ExtensionRoute; params: Record<string, string> } | undefined {
  const parts = segments(path);
  if (parts === undefined) return undefined;
  let best: { route: ExtensionRoute; params: Record<string, string>; fixed: number } | undefined;
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = segments(route.path)!;
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let fixed = 0;
    const matches = pattern.every((part, index) => {
      if (part.startsWith(":")) {
        params[part.slice(1)] = parts[index]!;
        return true;
      }
      fixed++;
      return part === parts[index];
    });
    if (matches && (best === undefined || fixed > best.fixed)) best = { route, params, fixed };
  }
  return best === undefined ? undefined : { route: best.route, params: best.params };
}

/** `/a/b%20c/` → `["a", "b c"]`; undefined for a segment that doesn't decode. */
function segments(path: string): string[] | undefined {
  try {
    return path
      .split("/")
      .filter((part) => part !== "")
      .map((part) => decodeURIComponent(part));
  } catch {
    return undefined;
  }
}

/** A player's settings over the defaults; the defaults alone when they don't fit. */
function fillPlayerSettings(schema: TSchema, chosen: JsonObject | undefined): unknown {
  const value = Value.Default(schema, Value.Clone(chosen ?? {}));
  return Value.Check(schema, value) ? value : Value.Default(schema, {});
}

/**
 * Checks what a player chose for an installed extension, before their profile keeps it. Throws
 * `InvalidProfile` for an extension that isn't installed or takes no player settings.
 */
export function checkPlayerSettings(
  installed: readonly SetUpExtension[],
  name: string,
  chosen: JsonObject,
): void {
  const found = installed.find(({ extension }) => extension.name === name);
  if (found === undefined) throw new InvalidProfile(`No extension "${name}"`);
  const schema = found.playerSettings;
  if (schema === undefined)
    throw new InvalidProfile(`Extension "${name}" takes no player settings`);
  const value = Value.Default(schema, Value.Clone(chosen));
  if (!Value.Check(schema, value)) {
    const problems = [...Value.Errors(schema, value)]
      .slice(0, 5)
      .map((error) => `${error.instancePath || "/"} ${error.message}`);
    throw new InvalidProfile(`Invalid settings for extension "${name}": ${problems.join("; ")}`);
  }
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}
