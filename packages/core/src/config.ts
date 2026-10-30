import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { openSecrets, SettingSecrets } from "./setting-secrets.ts";

const ModelRefSchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
});

const StyleSchema = Type.Union([
  Type.Literal("concise"),
  Type.Literal("balanced"),
  Type.Literal("detailed"),
]);
export type Style = Static<typeof StyleSchema>;

const AutonomySchema = Type.Union([
  Type.Literal("cautious"),
  Type.Literal("balanced"),
  Type.Literal("independent"),
]);
export type Autonomy = Static<typeof AutonomySchema>;

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

/**
 * Extra instructions: free text, or key/value pairs such as `{ "tools": "Search before asking." }`
 * that say how to go about a problem, which tools to use and the like.
 */
const InstructionsSchema = Type.Union([Type.String(), Type.Record(Type.String(), Type.String())]);
export type Instructions = Static<typeof InstructionsSchema>;

/** Instructions as the text the system prompt has: key/value pairs become a `key: value` line each. */
export function renderInstructions(instructions: Instructions): string {
  if (typeof instructions === "string") return instructions;
  return Object.entries(instructions)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

const AssistantSchema = Type.Object({
  /** URL-safe name; also the default display name. */
  name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
  displayName: Type.Optional(Type.String()),
  /** SQLite file, relative to the config file. */
  database: Type.Optional(Type.String()),
  model: Type.Optional(ModelRefSchema),
  /** IANA time zone the assistant tells time in. Default: the host's. */
  timeZone: Type.Optional(Type.String()),
  instructions: Type.Optional(InstructionsSchema),
  /** How much it says: "concise" (the default), "balanced" or "detailed". */
  style: Type.Optional(StyleSchema),
  /** How much it decides itself before asking: "cautious", "balanced" (the default) or "independent". */
  autonomy: Type.Optional(AutonomySchema),
  /** Installed after the built-in extension, in order. */
  extensions: Type.Optional(Type.Array(ExtensionSchema)),
  /** Monthly limits on model spend, in US dollars as the model catalog prices it. */
  budget: Type.Optional(
    Type.Object({
      monthlyUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      perPlayerUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      warnAt: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
      /** Without `monthlyUsd`, admins hear once a month when spend reaches it; default 25. */
      warnUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    }),
  ),
});

/**
 * Where backups are copied off the machine, besides `dir` (ADR 8): an S3-compatible bucket or a
 * WebDAV folder. Its credentials are kept on the server (`server/backup-remote`), not here.
 */
const BackupRemoteSchema = Type.Union([
  Type.Object({
    type: Type.Literal("s3"),
    /** Such as https://s3.eu-north-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com. */
    endpoint: Type.String({ pattern: "^https?://" }),
    bucket: Type.String({ minLength: 1 }),
    /** Default the one in an AWS endpoint, else us-east-1 (R2 takes "auto"). */
    region: Type.Optional(Type.String({ minLength: 1 })),
    /** A folder in the bucket, such as "nudge/". */
    prefix: Type.Optional(Type.String()),
    /** Bucket in the path rather than the host name; default on, except for AWS. */
    pathStyle: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal("webdav"),
    /** The folder, such as https://cloud.example/remote.php/dav/files/me/nudge/. */
    url: Type.String({ pattern: "^https?://" }),
  }),
]);

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
  /** Each backup is uploaded here too, and the same number kept there. */
  remote: Type.Optional(BackupRemoteSchema),
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

/** What is kept from the models beyond the rules (ADR 22, ADR 15). */
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
export type BackupSettings = Static<typeof BackupSchema>;
export type BackupRemoteConfig = Static<typeof BackupRemoteSchema>;

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
  const secrets = new SettingSecrets(baseDir);
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
              ...(extension.settings === undefined
                ? {}
                : { settings: openSettings(extension, assistant.name, secrets) }),
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
/** An extension's settings with the secrets the config refers to put back (`SettingSecrets`). */
function openSettings(
  extension: Static<typeof ExtensionSchema>,
  assistant: string,
  secrets: SettingSecrets,
): Record<string, unknown> {
  const { value, missing } = openSecrets(extension.settings, (id) => secrets.get(assistant, id));
  if (missing.length > 0)
    throw new ConfigError(
      `${assistant}: ${extension.from} refers to secrets that aren't in server/settings-secrets (${missing.join(", ")}); set those settings again`,
    );
  return value as Record<string, unknown>;
}

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
