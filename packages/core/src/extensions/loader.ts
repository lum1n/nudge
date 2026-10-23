import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@earendil-works/pi-durable";
import { ConfigError, type ExtensionConfig } from "../config.ts";
import {
  aboutExtension,
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
 * One that fails to load is in the list as a stand-in whose setup throws why, so the assistant
 * opens without it and lists it as broken, named by `from`.
 */
export async function loadExtensions(
  entries: readonly ExtensionConfig[],
  options: LoadOptions = {},
): Promise<ExtensionInput[]> {
  const fresh = options.fresh === true ? ++generation : undefined;
  const loaded: ExtensionInput[] = [];
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    try {
      const extension = await importExtension(entry.from, fresh);
      if (isNudgeExtension(extension))
        loaded.push({
          extension,
          settings: entry.settings,
          ...(entry.rooms === undefined ? {} : { rooms: entry.rooms }),
        });
      else if (entry.settings !== undefined)
        throw new ConfigError(
          `${entry.from} is a plain Pi Durable extension; it takes no settings`,
        );
      else loaded.push(entry.rooms === undefined ? extension : { extension, rooms: entry.rooms });
    } catch (error) {
      loaded.push(unloadable(entry.from, error));
    }
  }
  return loaded;
}

/** Stands in for an extension that failed to load; see `loadExtensions`. */
function unloadable(from: string, error: unknown): NudgeExtension {
  return {
    kind: "nudge.extension",
    name: from,
    version: "",
    setup: () => {
      throw error;
    },
  };
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
    /** What works but someone should know about (`warnings`). */
    warnings: readonly string[];
    /** Why its setup threw; the assistant opens without it. */
    error?: string;
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
    let setUp;
    try {
      setUp = await setUpExtension(input, host);
    } catch (error) {
      // The assistant opens without it, so the others are still worth checking.
      const { name, version } = aboutExtension(input);
      checked.push({
        name,
        ...(version === undefined ? {} : { version }),
        models: [],
        problems: [],
        warnings: [],
        error: (error as Error).message,
      });
      continue;
    }
    const { extension, version, models, problems, warnings, close } = setUp;
    const found = (await problems?.()) ?? [];
    const warned = (await warnings?.()) ?? [];
    await close?.();
    checked.push({
      name: extension.name,
      ...(version === undefined ? {} : { version }),
      models,
      problems: found,
      warnings: warned,
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
