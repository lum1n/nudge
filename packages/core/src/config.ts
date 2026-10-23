import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const ModelRefSchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
});

/** An OpenAI-compatible server, such as Ollama, llama.cpp or vLLM. */
const LocalProviderSchema = Type.Object({
  id: Type.String(),
  baseUrl: Type.String(),
  /** Environment variable holding the key; absent for keyless servers. */
  apiKeyEnv: Type.Optional(Type.String()),
  /** Ollama and most local servers reject the `developer` role. */
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  models: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
      contextWindow: Type.Optional(Type.Number()),
      maxTokens: Type.Optional(Type.Number()),
      reasoning: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1 },
  ),
});

const ExtensionSchema = Type.Object({
  /** A file or package directory, relative to the config file, or an installed package name. */
  from: Type.String({ minLength: 1 }),
  /** Checked against the extension's own schema when it is installed. */
  settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** Default true; false keeps the entry without installing it. */
  enabled: Type.Optional(Type.Boolean()),
  /** The kinds of room it is on in unless a room turns it on or off; default every kind. */
  rooms: Type.Optional(
    Type.Array(
      Type.Union([Type.Literal("lobby"), Type.Literal("personal"), Type.Literal("shared")]),
      { uniqueItems: true },
    ),
  ),
});

const AssistantSchema = Type.Object({
  /** URL-safe name; also the default display name. */
  name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
  displayName: Type.Optional(Type.String()),
  /** SQLite file, relative to the config file. */
  database: Type.Optional(Type.String()),
  model: Type.Optional(ModelRefSchema),
  /** IANA time zone the assistant tells time in. Default: the host's. */
  timeZone: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.String()),
  /** Installed after the built-in extension, in order. */
  extensions: Type.Optional(Type.Array(ExtensionSchema)),
  /** Monthly limits on model spend, in US dollars as the model catalog prices it. */
  budget: Type.Optional(
    Type.Object({
      monthlyUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      perPlayerUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      warnAt: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
    }),
  ),
});

/** Encrypted backups `nudge serve` makes on its own; `nudge backup` makes one at any time. */
const BackupSchema = Type.Object({
  /** Where backups go, relative to the config file: a disk, a mounted share, a synced folder. */
  dir: Type.String({ minLength: 1 }),
  /** Hours between backups; default 24. */
  everyHours: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  /** Backups kept; older ones are deleted. Default 14. */
  keep: Type.Optional(Type.Integer({ minimum: 1 })),
  /** The key, unless NUDGE_BACKUP_KEY is set; default nudge-backup.key beside the config. */
  keyFile: Type.Optional(Type.String()),
});

/** How the server is reached (ADR 11); `nudge serve`'s flags override it. */
const ServerSchema = Type.Object({
  /** The address apps and other assistants reach it at, such as https://robin.exe.xyz. */
  publicUrl: Type.Optional(Type.String({ pattern: "^https?://" })),
  /** Behind a proxy that ends TLS, such as exe.dev's: believe its `X-Forwarded-*` headers. */
  trustProxy: Type.Optional(Type.Boolean()),
  /** Whether the server installs new releases itself; default "auto". */
  updates: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("off")])),
});

/** What is kept from the models beyond the rules (ADR 14, ADR 15). */
const PrivacySchema = Type.Object({
  /**
   * The local model that hides names, places and organisations too, which are readable otherwise.
   * "off" (default) never downloads or runs it, "required" refuses requests while it is missing,
   * "preferred" sends them with the rules alone meanwhile.
   */
  deep: Type.Optional(
    Type.Union([Type.Literal("required"), Type.Literal("preferred"), Type.Literal("off")]),
  ),
  /** Words the local model never hides, such as a shop it keeps taking for a person. */
  allow: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export const NudgeConfigSchema = Type.Object({
  server: Type.Optional(ServerSchema),
  privacy: Type.Optional(PrivacySchema),
  /** None on a server set up but not given one yet, or whose last assistant was deleted. */
  assistants: Type.Array(AssistantSchema),
  providers: Type.Optional(Type.Array(LocalProviderSchema)),
  backup: Type.Optional(BackupSchema),
});

export type NudgeConfig = Static<typeof NudgeConfigSchema>;
export type AssistantConfig = Static<typeof AssistantSchema>;
export type ExtensionConfig = Static<typeof ExtensionSchema>;
export type LocalProviderConfig = Static<typeof LocalProviderSchema>;
export type ServerSettings = Static<typeof ServerSchema>;
export type PrivacySettings = Static<typeof PrivacySchema>;
export type ModelChoice = Static<typeof ModelRefSchema>;

export const DEFAULT_MODEL: ModelChoice = { provider: "anthropic", modelId: "claude-sonnet-5" };

export const DEFAULT_CONFIG: NudgeConfig = { assistants: [{ name: "nudge" }] };

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** There is no config file where one was looked for. */
export class ConfigMissing extends ConfigError {
  override name = "ConfigMissing";
  constructor(readonly path: string) {
    super(`There is no ${path}: run "nudge init" to make one`);
  }
}

/** Parses and validates a config; relative database paths resolve against `baseDir`. */
export function parseConfig(value: unknown, baseDir: string): NudgeConfig {
  if (typeof value === "object" && value !== null && "push" in value)
    throw new ConfigError(
      'Pushes are an extension now: remove "push" and add { "from": "./extensions/push", "settings": { … } } to each assistant\'s extensions, with what "push" had (preview, subject, apns, fcm). Its key files are read from the directory nudge runs in, or give them as absolute paths.',
    );
  if (!Value.Check(NudgeConfigSchema, value)) {
    const problems = [...Value.Errors(NudgeConfigSchema, value)]
      .slice(0, 5)
      .map((error) => `${error.instancePath || "/"} ${error.message}`);
    throw new ConfigError(`Invalid config:\n  ${problems.join("\n  ")}`);
  }
  const names = new Set<string>();
  for (const assistant of value.assistants) {
    if (names.has(assistant.name))
      throw new ConfigError(`Assistant "${assistant.name}" is configured twice`);
    names.add(assistant.name);
  }
  return {
    ...value,
    ...(value.backup === undefined
      ? {}
      : {
          backup: {
            ...value.backup,
            dir: resolve(baseDir, value.backup.dir),
            ...(value.backup.keyFile === undefined
              ? {}
              : { keyFile: resolve(baseDir, value.backup.keyFile) }),
          },
        }),
    assistants: value.assistants.map((assistant) => ({
      ...assistant,
      database: resolve(baseDir, assistant.database ?? `data/${assistant.name}.sqlite`),
      ...(assistant.extensions === undefined
        ? {}
        : {
            extensions: assistant.extensions.map((extension) => ({
              ...extension,
              from: resolveExtension(extension.from, baseDir),
            })),
          }),
    })),
  };
}

/**
 * Where an extension's module is: a path becomes an absolute file (a package directory becomes the
 * file its package.json exports), a package name is looked up from `baseDir`. A package that cannot
 * be found from there stays a bare name for `import()` to try.
 */
export function resolveExtension(from: string, baseDir: string): string {
  if (!(from.startsWith(".") || isAbsolute(from))) {
    try {
      return createRequire(join(baseDir, "nudge.json")).resolve(from);
    } catch {
      return from;
    }
  }
  const path = resolve(baseDir, from);
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) throw new ConfigError(`Extension ${from} not found at ${path}`);
  if (!stats.isDirectory()) return path;
  try {
    const manifest = join(path, "package.json");
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    if (name === undefined) throw new Error(`${manifest} has no name`);
    // A package may import itself by name, which goes through its `exports`.
    return createRequire(manifest).resolve(name);
  } catch (error) {
    throw new ConfigError(`Extension ${from} is not a package: ${(error as Error).message}`);
  }
}

/** Reads `nudge.json`. A missing file is a `ConfigMissing`, so nothing starts in the wrong place. */
export async function loadConfig(path: string): Promise<NudgeConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigMissing(path);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(value, dirname(resolve(path)));
}
