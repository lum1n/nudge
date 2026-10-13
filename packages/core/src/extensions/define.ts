import type { Extension } from "@earendil-works/pi-durable";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { ConfigError } from "../config.ts";
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
};

/** What `setup` returns: a Pi Durable extension without its name, and detectors for redaction. */
export type ExtensionParts = Omit<Extension, "name"> & {
  /** Personal data the extension knows how to find; they run after the assistant's own. */
  readonly detectors?: readonly PiiDetector[];
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
};

/** Checks the settings and runs `setup`. A plain extension passes through. */
export async function setUpExtension(
  input: ExtensionInput,
  host: Omit<ExtensionHost<unknown>, "settings">,
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
    return { extension, detectors: [] };
  }
  const { extension: definition } = use;
  const settings = checkSettings(definition, use.settings);
  const { detectors = [], ...parts } = await definition.setup({ ...host, settings });
  return {
    extension: { ...parts, name: definition.name },
    version: definition.version,
    detectors,
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
