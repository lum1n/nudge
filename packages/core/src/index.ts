import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { type AssistantConfig, ConfigError, DEFAULT_MODEL, type NudgeConfig } from "./config.ts";
import { loadExtensions } from "./extensions/loader.ts";
import { buildModels } from "./models/providers.ts";
import {
  ExtensionNotFound,
  type InstalledExtension,
  type ModelViewMessage,
  Nudge,
  type NudgeOptions,
  type PrivacyOptions,
  type RoomExtension,
  RoomNotFound,
} from "./nudge.ts";

export {
  type AssistantConfig,
  ConfigError,
  DEFAULT_CONFIG,
  DEFAULT_MODEL,
  type ExtensionConfig,
  type LocalProviderConfig,
  loadConfig,
  type ModelChoice,
  type NudgeConfig,
  parseConfig,
} from "./config.ts";
export {
  AlreadyDecided,
  APPROVAL_ENTRY,
  type Approval,
  type ApprovalDraft,
  type ApprovalEntryData,
  type ApprovalHandler,
  ApprovalNotFound,
  type ApprovalOutcome,
  type ApprovalRun,
  Approvals,
  ApprovalsDoc,
  type ApprovalStatus,
  type Decision,
  MAX_PENDING,
  requestApproval,
} from "./approvals/approvals.ts";
export { type Change, type ChangeListener, Changes } from "./changes.ts";
export {
  type Budget,
  BudgetReached,
  type MonthSpend,
  SpendDoc,
  Spending,
  type SpendState,
  type SpendWarning,
  totalCost,
} from "./spending.ts";
export {
  type AnswerCause,
  type RoomEvent,
  type RoomEventListener,
  RoomEvents,
} from "./room-events.ts";
export { describeRoom, formatHour } from "./extensions/builtin.ts";
export {
  defineNudgeExtension,
  type ExtensionDocuments,
  type ExtensionHost,
  type ExtensionInput,
  type ExtensionParts,
  type ExtensionUse,
  type NudgeExtension,
  type RoomSocket,
  type RoomSocketHandler,
  type RoomSocketSession,
} from "./extensions/define.ts";
export { checkExtensions, type LoadOptions, loadExtensions } from "./extensions/loader.ts";
// What an extension needs to build tools and sections, so it can depend on @nudge/core alone.
export { Type } from "@earendil-works/pi-ai";
export { defineTool, hook, section } from "@earendil-works/pi-durable";
export {
  type Author,
  MESSAGE_ENTRY,
  type MessageDraft,
  type MessageEntryData,
} from "./host-api.ts";
export {
  canUse,
  type ClientInfo,
  DirectoryDoc,
  type DirectoryState,
  LOBBY,
  type PairingRecord,
  type SideConversation,
  type Player,
  type Room,
  type RoomKind,
  roomOf,
  type TokenRecord,
} from "./identity/directory.ts";
export {
  type Credential,
  type Invitation,
  isAdmin,
  PAIRING_TTL_MS,
  type PairingCode,
  Players,
} from "./identity/players.ts";
export {
  type Fact,
  type FactPerson,
  MAX_FACT_LENGTH,
  MAX_FACTS,
  Memory,
  MemoryDoc,
  MemoryFull,
  PlayerMemoryDoc,
  type RoomFact,
} from "./memory/memory.ts";
export { Rooms, type SharedRoomDraft } from "./identity/rooms.ts";
export { scrubSecrets, SecretStore } from "./secrets.ts";
export { type NudgeDraft, Nudges } from "./nudges/nudges.ts";
export { formatTime, parseTime, ScheduleDoc, type ScheduledNudge } from "./nudges/schedule.ts";
export { FIRE_ENTRY, type FireEntryData, NudgeTimer } from "./nudges/timer-task.ts";
export { buildModels } from "./models/providers.ts";
export { RedactingModels, type RedactionOptions } from "./models/redacting-models.ts";
export {
  builtinDetectors,
  type PiiDetector,
  regexDetector,
  type Span,
} from "./privacy/detectors.ts";
export { Vault, type VaultEntry } from "./privacy/vault.ts";
export {
  type DatabaseEncryption,
  type DatabaseKey,
  DatabaseKeyError,
  databaseEncryption,
  databaseKey,
  decryptDatabase,
  encryptDatabase,
  keyFile,
} from "./encrypted-storage.ts";
export { DatabaseInUse, lockDatabase } from "./storage-lock.ts";
export {
  ExtensionNotFound,
  type InstalledExtension,
  Nudge,
  type NudgeOptions,
  type PrivacyOptions,
  type RoomExtension,
  RoomNotFound,
};

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

/**
 * Opens one configured assistant with its extensions. Pass `models` to share one catalog between
 * assistants.
 */
export async function openAssistant(
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
      extensions: await loadExtensions(assistant.extensions ?? []),
      ...(assistant.budget === undefined ? {} : { budget: assistant.budget }),
      ...overrides,
    },
    context,
  );
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
