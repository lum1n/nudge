import { join } from "node:path";
import type { Extension, Session } from "@earendil-works/pi-durable";
import type { ApprovalHandler } from "../approvals/approvals.ts";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { ConfigError } from "../config.ts";
import type { Player, Room, RoomKind } from "../identity/directory.ts";
import type { PiiDetector } from "../privacy/detectors.ts";
import type { RoomEvent } from "../room-events.ts";
import { SecretStore } from "../secrets.ts";

/** What an extension's `setup` gets from the assistant it is installed in. */
export type ExtensionHost<Settings> = {
  /** The extension's settings from the config, checked against its schema, defaults filled in. */
  readonly settings: Settings;
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
};

/** Reading, watching and changing the assistant's documents. */
export type ExtensionDocuments = Pick<Session, "snapshot" | "watchDoc" | "commit">;

/**
 * What the assistant gives every extension; `setUpExtension` adds the settings and each one's
 * `dataDir` and `secrets`.
 */
export type HostBase = Omit<ExtensionHost<unknown>, "settings" | "dataDir" | "secrets"> & {
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

/** What `setup` returns: a Pi Durable extension without its name, and detectors for redaction. */
export type ExtensionParts = Omit<Extension, "name"> & {
  /** Personal data the extension knows how to find; they run after the assistant's own. */
  readonly detectors?: readonly PiiDetector[];
  /** A WebSocket per room for the extension's own client UI. */
  readonly roomSocket?: RoomSocketHandler;
  /** Models the extension calls itself, so `nudge doctor` can check their credentials. */
  readonly models?: readonly { readonly provider: string; readonly modelId: string }[];
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
};

export type NudgeExtension<S extends TSchema = TSchema> = {
  readonly kind: "nudge.extension";
  /** Lower-case letters, digits and dashes. Installing another extension with this name replaces it. */
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  /** TypeBox schema of the settings; without one the extension takes none. */
  readonly settings?: S;
  /** Runs once per assistant at open, and again on every reload. */
  setup(host: ExtensionHost<Static<S>>): ExtensionParts | Promise<ExtensionParts>;
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

/** The name the built-in extension uses; nothing else may take it. */
export const BUILTIN_NAME = "nudge";

export function defineNudgeExtension<S extends TSchema = TSchema>(
  extension: Omit<NudgeExtension<S>, "kind">,
): NudgeExtension<S> {
  if (!NAME.test(extension.name))
    throw new Error(
      `Extension name "${extension.name}" is not lower-case letters, digits and dashes`,
    );
  if (extension.name === BUILTIN_NAME)
    throw new Error(`"${BUILTIN_NAME}" is the built-in extension`);
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
  /** Default every kind; see `ExtensionUse.rooms`. */
  readonly rooms?: readonly RoomKind[];
  readonly detectors: readonly PiiDetector[];
  readonly roomSocket?: RoomSocketHandler;
  readonly models: readonly { readonly provider: string; readonly modelId: string }[];
  readonly approvals: Readonly<Record<string, ApprovalHandler>>;
  readonly onRoomEvent?: (event: RoomEvent) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
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
    return { extension, detectors: [], models: [], approvals: {}, ...rooms };
  }
  const definition = use.extension;
  const settings = checkSettings(definition, use.settings);
  const { dataRoot, ...base } = host;
  const dataDir = dataRoot === undefined ? undefined : join(dataRoot, definition.name);
  const secrets = new SecretStore(dataDir === undefined ? undefined : join(dataDir, "secrets"));
  const {
    detectors = [],
    roomSocket,
    models = [],
    approvals = {},
    onRoomEvent,
    close,
    ...parts
  } = await definition.setup({
    ...base,
    settings,
    secrets,
    ...(dataDir === undefined ? {} : { dataDir }),
  });
  return {
    extension: { ...parts, name: definition.name },
    version: definition.version,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...rooms,
    detectors,
    models,
    approvals,
    ...(roomSocket === undefined ? {} : { roomSocket }),
    ...(onRoomEvent === undefined ? {} : { onRoomEvent }),
    ...(close === undefined ? {} : { close }),
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

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}
