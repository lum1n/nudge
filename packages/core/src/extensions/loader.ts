import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@earendil-works/pi-durable";
import { ConfigError, type ExtensionConfig } from "../config.ts";
import {
  type ExtensionInput,
  isNudgeExtension,
  type NudgeExtension,
  setUpExtension,
} from "./define.ts";

let generation = 0;

export type LoadOptions = {
  /**
   * Import the modules again instead of taking them from Node's module cache, for a reload. Only
   * the module itself is fresh: what it imports stays cached. Package names cannot be reloaded.
   */
  readonly fresh?: boolean;
};

/**
 * Imports the enabled extensions of a config, in order. A module exports its extension as
 * `default` or as `extension`: one made with `defineNudgeExtension`, or a plain Pi Durable one.
 */
export async function loadExtensions(
  entries: readonly ExtensionConfig[],
  options: LoadOptions = {},
): Promise<ExtensionInput[]> {
  const fresh = options.fresh === true ? ++generation : undefined;
  const loaded: ExtensionInput[] = [];
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const extension = await importExtension(entry.from, fresh);
    if (isNudgeExtension(extension))
      loaded.push({
        extension,
        settings: entry.settings,
        ...(entry.rooms === undefined ? {} : { rooms: entry.rooms }),
      });
    else if (entry.settings !== undefined)
      throw new ConfigError(`${entry.from} is a plain Pi Durable extension; it takes no settings`);
    else loaded.push(entry.rooms === undefined ? extension : { extension, rooms: entry.rooms });
  }
  return loaded;
}

/**
 * Loads a config's extensions and runs their setup without an assistant, to check modules, exports
 * and settings. Lists them as they would be installed.
 */
export async function checkExtensions(entries: readonly ExtensionConfig[]): Promise<
  {
    name: string;
    version?: string;
    models: readonly { provider: string; modelId: string }[];
    /** What keeps it from working on this machine (`problems`). */
    problems: readonly string[];
  }[]
> {
  const host = {
    name: "check",
    displayName: "Nudge",
    timeZone: "UTC",
    now: Date.now,
    protect: () => Promise.reject(new Error("No assistant is open while checking")),
    release: () => Promise.reject(new Error("No assistant is open while checking")),
    documents: () => {
      throw new Error("No assistant is open while checking");
    },
    assistant: () => {
      throw new Error("No assistant is open while checking");
    },
    // Nothing opens while checking.
    whenOpen: () => new Promise<never>(() => {}),
  };
  const checked: Awaited<ReturnType<typeof checkExtensions>> = [];
  for (const input of await loadExtensions(entries)) {
    const { extension, version, models, problems, close } = await setUpExtension(input, host);
    const found = (await problems?.()) ?? [];
    await close?.();
    checked.push({
      name: extension.name,
      ...(version === undefined ? {} : { version }),
      models,
      problems: found,
    });
  }
  return checked;
}

export async function importExtension(
  from: string,
  fresh?: number,
): Promise<NudgeExtension | Extension> {
  let specifier = from;
  if (isAbsolute(from)) {
    const url = pathToFileURL(from);
    if (fresh !== undefined) url.searchParams.set("reload", String(fresh));
    specifier = url.href;
  }
  let module: { default?: unknown; extension?: unknown };
  try {
    module = (await import(specifier)) as typeof module;
  } catch (error) {
    throw new ConfigError(`Could not load extension ${from}: ${(error as Error).message}`);
  }
  const extension = module.extension ?? module.default;
  if (isNudgeExtension(extension) || isPlainExtension(extension)) return extension;
  throw new ConfigError(
    `${from} exports no extension; export one made with defineNudgeExtension as default`,
  );
}

function isPlainExtension(value: unknown): value is Extension {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    !("setup" in value)
  );
}
