import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { ConfigError } from "../config.ts";
import type { Player, Room } from "../identity/directory.ts";
import type { PiiDetector } from "../privacy/detectors.ts";

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
};

/** What the assistant gives every extension; `setUpExtension` adds the settings and each one's `dataDir`. */
export type HostBase = Omit<ExtensionHost<unknown>, "settings" | "dataDir"> & {
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
  client: { readonly room: Room; readonly player: Player },
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
  readonly extension: NudgeExtension;
  readonly settings?: unknown;
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
  readonly detectors: readonly PiiDetector[];
  readonly roomSocket?: RoomSocketHandler;
  readonly models: readonly { readonly provider: string; readonly modelId: string }[];
};

/** Checks the settings and runs `setup`. A plain extension passes through. */
export async function setUpExtension(
  input: ExtensionInput,
  host: HostBase,
): Promise<SetUpExtension> {
  const use: ExtensionUse | undefined = isNudgeExtension(input)
    ? { extension: input }
    : "extension" in input
      ? input
      : undefined;
  if (use === undefined) {
    const extension = input as Extension;
    if (extension.name === BUILTIN_NAME)
      throw new Error(`"${BUILTIN_NAME}" is the built-in extension`);
    return { extension, detectors: [], models: [] };
  }
  const { extension: definition } = use;
  const settings = checkSettings(definition, use.settings);
  const { dataRoot, ...base } = host;
  const dataDir = dataRoot === undefined ? undefined : join(dataRoot, definition.name);
  const {
    detectors = [],
    roomSocket,
    models = [],
    ...parts
  } = await definition.setup({
    ...base,
    settings,
    ...(dataDir === undefined ? {} : { dataDir }),
  });
  return {
    extension: { ...parts, name: definition.name },
    version: definition.version,
    detectors,
    models,
    ...(roomSocket === undefined ? {} : { roomSocket }),
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
