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
});

export const NudgeConfigSchema = Type.Object({
  assistants: Type.Array(AssistantSchema, { minItems: 1 }),
  providers: Type.Optional(Type.Array(LocalProviderSchema)),
});

export type NudgeConfig = Static<typeof NudgeConfigSchema>;
export type AssistantConfig = Static<typeof AssistantSchema>;
export type ExtensionConfig = Static<typeof ExtensionSchema>;
export type LocalProviderConfig = Static<typeof LocalProviderSchema>;
export type ModelChoice = Static<typeof ModelRefSchema>;

export const DEFAULT_MODEL: ModelChoice = { provider: "anthropic", modelId: "claude-sonnet-5" };

export const DEFAULT_CONFIG: NudgeConfig = { assistants: [{ name: "nudge" }] };

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Parses and validates a config; relative database paths resolve against `baseDir`. */
export function parseConfig(value: unknown, baseDir: string): NudgeConfig {
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
function resolveExtension(from: string, baseDir: string): string {
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

/** Reads `nudge.json`; a missing file gives the default config next to it. */
export async function loadConfig(path: string): Promise<NudgeConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return parseConfig(DEFAULT_CONFIG, dirname(path));
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
