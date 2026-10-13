import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
});

export const NudgeConfigSchema = Type.Object({
  assistants: Type.Array(AssistantSchema, { minItems: 1 }),
  providers: Type.Optional(Type.Array(LocalProviderSchema)),
});

export type NudgeConfig = Static<typeof NudgeConfigSchema>;
export type AssistantConfig = Static<typeof AssistantSchema>;
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
    })),
  };
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
