import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { ConfigError, type NudgeConfig, parseConfig, resolveExtension } from "../config.ts";
import { rawAssistant, readRawConfig, writeRawConfig } from "../config-file.ts";
import type { RoomKind } from "../identity/directory.ts";
import { isNudgeExtension } from "./define.ts";
import { importExtension } from "./loader.ts";

/** An extension as the settings page sets it up: from the config, or found beside it. */
export type ExtensionSetup = {
  /** As the config writes it; the page sends it back to say which one. */
  readonly from: string;
  /** Absent when the module could not be loaded. */
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  /** In the config; false for one found in `extensions/` that nobody added yet. */
  readonly configured: boolean;
  /** Installed: configured and not `enabled: false`. */
  readonly enabled: boolean;
  readonly rooms?: RoomKind[];
  /** As the config has them, `$comment` keys left out. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** The extension's settings schema, as JSON Schema; absent when it takes none. */
  readonly schema?: unknown;
  /** `${NAME}` references in its settings, defaults included, that the environment doesn't set. */
  readonly missingEnv: string[];
  /** Why the module could not be loaded. */
  readonly error?: string;
};

/** One extension as the settings page saves it, in the order it is installed. */
export type ExtensionChoice = {
  readonly from: string;
  readonly enabled: boolean;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly rooms?: readonly RoomKind[];
};

const COMMENT = "$comment";
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The assistant's extensions in config order, then the packages in `extensions/` beside the
 * config and the bundled ones (`offered`) that it doesn't use yet, each with its settings schema.
 */
export async function listExtensionSetups(
  configPath: string,
  assistant: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  offered: readonly string[] = bundled(),
): Promise<ExtensionSetup[]> {
  const baseDir = dirname(resolve(configPath));
  const entries = rawAssistant(await readRawConfig(configPath), assistant).extensions ?? [];
  const setups: ExtensionSetup[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    seen.add(resolvedOrSelf(entry.from, baseDir));
    setups.push(
      await describe(
        entry.from,
        {
          configured: true,
          enabled: entry.enabled !== false,
          settings: withoutComment(entry.settings ?? {}),
          ...(entry.rooms === undefined ? {} : { rooms: [...entry.rooms] }),
        },
        baseDir,
        env,
      ),
    );
  }
  for (const from of [...(await foundBeside(baseDir)), ...offered]) {
    if (seen.has(resolvedOrSelf(from, baseDir)) || seen.has(from)) continue;
    setups.push(
      await describe(from, { configured: false, enabled: false, settings: {} }, baseDir, env),
    );
  }
  return setups;
}

/**
 * Replaces the assistant's extensions in the config file with `choices`, keeping the `$comment`
 * keys of entries that stay. Only extensions already configured or found in `extensions/` may be
 * named, so the page can't load code from elsewhere. `apply` gets the new config before it is
 * written, such as to reinstall the extensions; when it throws the file is left as it was.
 */
export async function saveExtensionSetups(
  configPath: string,
  assistant: string,
  choices: readonly ExtensionChoice[],
  apply: (config: NudgeConfig) => Promise<void>,
): Promise<void> {
  const path = resolve(configPath);
  const baseDir = dirname(path);
  const raw = await readRawConfig(path);
  const target = rawAssistant(raw, assistant);
  const before = target.extensions ?? [];
  const allowed = new Set([
    ...before.map((entry) => entry.from),
    ...(await foundBeside(baseDir)),
    ...bundled(),
  ]);
  const names = new Set<string>();
  target.extensions = choices.map((choice) => {
    if (!allowed.has(choice.from))
      throw new ConfigError(`${choice.from} is not configured, bundled or in extensions/`);
    if (names.has(choice.from)) throw new ConfigError(`${choice.from} is listed twice`);
    names.add(choice.from);
    const old = before.find((entry) => entry.from === choice.from);
    const comment = old?.settings?.[COMMENT];
    const settings = {
      ...(comment === undefined ? {} : { [COMMENT]: comment }),
      ...withoutComment(choice.settings ?? {}),
    };
    return {
      ...(old?.$comment === undefined ? {} : { $comment: old.$comment }),
      from: choice.from,
      ...(Object.keys(settings).length === 0 ? {} : { settings }),
      ...(choice.rooms === undefined ? {} : { rooms: [...choice.rooms] }),
      ...(choice.enabled ? {} : { enabled: false }),
    };
  });
  if (target.extensions.length === 0) delete target.extensions;
  await apply(parseConfig(raw, baseDir));
  await writeRawConfig(path, raw);
}

async function describe(
  from: string,
  state: Pick<ExtensionSetup, "configured" | "enabled" | "settings" | "rooms">,
  baseDir: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ExtensionSetup> {
  try {
    const extension = await importExtension(resolveExtension(from, baseDir));
    if (!isNudgeExtension(extension))
      return { from, ...state, name: extension.name, missingEnv: [] };
    const schema = extension.settings;
    const filled = { ...defaultsOf(schema), ...state.settings };
    return {
      from,
      ...state,
      name: extension.name,
      version: extension.version,
      ...(extension.description === undefined ? {} : { description: extension.description }),
      // Through JSON: TypeBox keeps its own markers on symbols, which the page has no use for.
      ...(schema === undefined ? {} : { schema: JSON.parse(JSON.stringify(schema)) as unknown }),
      missingEnv: variablesIn(filled).filter((name) => !env[name]),
    };
  } catch (error) {
    return { from, ...state, missingEnv: [], error: (error as Error).message };
  }
}

/**
 * The extensions a server release ships (packages/release), by package name: offered on every
 * assistant's settings page where they can be loaded, as in a release, and not in a checkout,
 * where `extensions/` beside the config has them.
 */
export const BUNDLED_EXTENSIONS: readonly string[] = [
  "@nudge/ext-calendar",
  "@nudge/ext-codemode",
  "@nudge/ext-connectors",
  "@nudge/ext-documents",
  "@nudge/ext-federation",
  "@nudge/ext-lists",
  "@nudge/ext-mail",
  "@nudge/ext-matrix",
  "@nudge/ext-mcp",
  "@nudge/ext-ner",
  "@nudge/ext-push",
  "@nudge/ext-search",
  "@nudge/ext-signal",
  "@nudge/ext-telegram",
  "@nudge/ext-watches",
];

/** The bundled extensions this install has. */
export function bundled(): string[] {
  const require = createRequire(import.meta.url);
  return BUNDLED_EXTENSIONS.filter((name) => {
    try {
      require.resolve(name);
      return true;
    } catch {
      return false;
    }
  });
}

/** `./extensions/<dir>` for each package directory in `extensions/` beside the config. */
async function foundBeside(baseDir: string): Promise<string[]> {
  const root = join(baseDir, "extensions");
  const names = await readdir(root).catch(() => [] as string[]);
  const found: string[] = [];
  for (const name of names.sort()) {
    const manifest = await stat(join(root, name, "package.json")).catch(() => undefined);
    if (manifest?.isFile()) found.push(`./extensions/${name}`);
  }
  return found;
}

function resolvedOrSelf(from: string, baseDir: string): string {
  try {
    return resolveExtension(from, baseDir);
  } catch {
    return from;
  }
}

function withoutComment(settings: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { [COMMENT]: _, ...rest } = settings;
  return rest;
}

/** The top-level defaults of an object schema, the ones a setting left out falls back to. */
function defaultsOf(schema: unknown): Record<string, unknown> {
  const properties = (schema as { properties?: Record<string, { default?: unknown }> } | undefined)
    ?.properties;
  const defaults: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties ?? {}))
    if (property.default !== undefined) defaults[key] = property.default;
  return defaults;
}

function variablesIn(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") for (const match of item.matchAll(VARIABLE)) names.add(match[1]!);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (typeof item === "object" && item !== null) Object.values(item).forEach(visit);
  };
  visit(value);
  return [...names];
}
