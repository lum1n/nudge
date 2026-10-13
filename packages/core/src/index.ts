import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { type AssistantConfig, ConfigError, DEFAULT_MODEL, type NudgeConfig } from "./config.ts";
import { buildModels } from "./models/providers.ts";
import { Nudge, type NudgeOptions, type PrivacyOptions } from "./nudge.ts";

export {
  type AssistantConfig,
  ConfigError,
  DEFAULT_CONFIG,
  DEFAULT_MODEL,
  type LocalProviderConfig,
  loadConfig,
  type ModelChoice,
  type NudgeConfig,
  parseConfig,
} from "./config.ts";
export { formatHour } from "./extensions/builtin.ts";
export {
  type Author,
  MESSAGE_ENTRY,
  type MessageDraft,
  type MessageEntryData,
} from "./host-api.ts";
export { buildModels } from "./models/providers.ts";
export { RedactingModels, type RedactionOptions } from "./models/redacting-models.ts";
export {
  builtinDetectors,
  type PiiDetector,
  regexDetector,
  type Span,
} from "./privacy/detectors.ts";
export { Vault, type VaultEntry } from "./privacy/vault.ts";
export { Nudge, type NudgeOptions, type PrivacyOptions };

export function createNudge(options: NudgeOptions, context: Context): Promise<Nudge> {
  return Nudge.open(options, context);
}

/** Picks an assistant from the config, by name or the first one. */
export function findAssistant(config: NudgeConfig, name?: string): AssistantConfig {
  const assistant =
    name === undefined ? config.assistants[0] : config.assistants.find((a) => a.name === name);
  if (assistant === undefined) throw new ConfigError(`No assistant named "${name}" in the config`);
  return assistant;
}

/** Opens one configured assistant. Pass `models` to share one catalog between assistants. */
export function openAssistant(
  config: NudgeConfig,
  assistant: AssistantConfig,
  context: Context,
  overrides: Partial<NudgeOptions> & { models?: Models } = {},
): Promise<Nudge> {
  return Nudge.open(
    {
      database: assistant.database ?? ":memory:",
      models: overrides.models ?? buildModels(config.providers),
      model: assistant.model ?? DEFAULT_MODEL,
      displayName: assistant.displayName ?? capitalize(assistant.name),
      timeZone: assistant.timeZone,
      instructions: assistant.instructions,
      ...overrides,
    },
    context,
  );
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
