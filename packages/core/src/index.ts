import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AssistantConfig,
  ConfigError,
  DEFAULT_MODEL,
  type NudgeConfig,
  renderInstructions,
} from "./config.ts";
import { loadExtensions } from "./extensions/loader.ts";
import { buildModels } from "./models/providers.ts";
import {
  type RedactedHistory,
  redactHistory,
  redactWhenOutdated,
} from "./privacy/redact-history.ts";
import {
  type BrokenExtension,
  ExtensionBroken,
  ExtensionNotFound,
  type InstalledExtension,
  NotAllowed,
  Nudge,
  type NudgeOptions,
  type PrivacyOptions,
  type PrivateValue,
  type PlayerSettingsSchema,
  RETIRE_TIMEOUT_MS,
  type RoomExtension,
  RoomNotFound,
} from "./nudge.ts";

export {
  type AssistantConfig,
  type Autonomy,
  ConfigError,
  ConfigMissing,
  DEFAULT_CONFIG,
  DEFAULT_MODEL,
  type ExtensionConfig,
  type LocalProviderConfig,
  loadConfig,
  type BackupRemoteConfig,
  type BackupSettings,
  type ModelChoice,
  type NudgeConfig,
  parseConfig,
  renderInstructions,
  type Instructions,
  type ServerSettings,
  type Style,
} from "./config.ts";
export {
  AdminOnly,
  AlreadyDecided,
  APPROVAL_ENTRY,
  type Approval,
  type ApprovalDraft,
  type ApprovalEntryData,
  type ApprovalDenialHandler,
  type ApprovalHandler,
  type ApprovalInput,
  ApprovalNotFound,
  type ApprovalOutcome,
  type ApprovalRun,
  Approvals,
  ApprovalsDoc,
  type ApprovalStatus,
  type ClientAction,
  type Decision,
  MAX_PENDING,
  MissingInputs,
  requestApproval,
} from "./approvals/approvals.ts";
export { consequentialLabel } from "./approvals/consequential.ts";
export {
  ATTACHMENT_MAX_BYTES,
  type AttachmentInfo,
  AttachmentNotFound,
  type AttachmentRecord,
  AttachmentRefused,
  AttachmentRemoved,
  Attachments,
  ATTACHMENTS_PER_MESSAGE,
  type AttachmentUpload,
  MODEL_IMAGE_MAX_BYTES,
} from "./attachments/attachments.ts";
export { type Change, type ChangeListener, Changes } from "./changes.ts";
export { type RawConfig, readRawConfig, writeRawConfig } from "./config-file.ts";
export {
  type AssistantChange,
  type AssistantDraft,
  AssistantExists,
  AssistantNotFound,
  Assistants,
  type AssistantsOptions,
} from "./server/assistants.ts";
export {
  ASSERTION_TTL_MS,
  federationEndpoint,
  fetchKeys,
  HomeBody,
  type Keys,
  KeysBody,
  KeysClaim,
  OwnerClaim,
  SKEW_MS,
} from "./federation/keys.ts";
export {
  checkSigned,
  newKey,
  open,
  peek,
  publicKeyOf,
  seal,
  type Sealed,
  type Signed,
  signPayload,
} from "./federation/signing.ts";
export { defaultExtensions } from "./server/defaults.ts";
export { defaultConfigPath, serverHome } from "./server/home.ts";
export {
  DATA_FORMAT,
  DataFormatError,
  dataFormatFile,
  recordedDataFormat,
  upgradeDataFormat,
} from "./server/data-format.ts";
export {
  type KeySource,
  readableError,
  ServerKeys,
  serverKeysDir,
  testProviderKey,
} from "./server/keys.ts";
export {
  LastOwner,
  type OwnerToken,
  type ServerOwner,
  ServerOwners,
  serverOwnersFile,
} from "./server/owners.ts";
export {
  HomeRefused,
  homeAtSetup,
  ownerFromHome,
  type OwnerSignIn,
  ServerIdentity,
  serverIdentityDir,
  type VouchedHome,
} from "./server/identity.ts";
export { openRecoveryKit, RecoveryKitError, sealRecoveryKit } from "./server/recovery.ts";
export {
  canonicalJson,
  checkManifest,
  confirmWhenHealthy,
  type ConfirmWhenHealthyOptions,
  newer,
  RELEASE_KEYS,
  RELEASE_MANIFEST_URL,
  type ReleaseManifest,
  RESTART_EXIT_CODE,
  UpdateError,
  Updates,
  type UpdatesOptions,
  type UpdateState,
} from "./server/updates.ts";
export {
  isWiredHost,
  loadWired,
  type RelayFront,
  routeOutgoing,
  ServerWired,
  serverWiredName,
  WiredError,
  type WiredModule,
  type WiredOptions,
  type WiredState,
} from "./server/wired.ts";
export {
  completeSetup,
  detectLocalServers,
  type LocalServer,
  newSetupCode,
  SetupCodes,
  type SetupChoices,
  type SetupResult,
  type SetupTarget,
} from "./server/setup.ts";
export {
  BACKUP_SUFFIX,
  BackupError,
  backupKey,
  backupNames,
  backupTime,
  createBackup,
  lastBackupAt,
  pruneBackups,
  readBackupManifest,
  restoreBackup,
} from "./backup.ts";
export {
  amzDate,
  type BackupRemote,
  backupRemoteDir,
  lastRemoteBackupAt,
  type RemoteCredentials,
  RemoteBackups,
  type RemoteState,
  signV4,
} from "./backup-remote.ts";
export {
  type Budget,
  BudgetReached,
  DEFAULT_WARN_USD,
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
export { Presence } from "./presence.ts";
export { describeRoom, formatToday } from "./extensions/builtin.ts";
export {
  defineNudgeExtension,
  EXTENSION_API_VERSION,
  ROOMS_SETTING,
  roomsSetting,
  type ExtensionAssistant,
  type ExtensionDocuments,
  type ExtensionHost,
  type ExtensionInput,
  type ExtensionParts,
  type ExtensionRoute,
  MAX_ROUTE_BODY,
  type RouteAuth,
  type RouteCaller,
  type ExtensionUse,
  type NudgeExtension,
  type RoomSocket,
  type RoomSocketHandler,
  type RoomSocketSession,
} from "./extensions/define.ts";
export { checkExtensions, type LoadOptions, loadExtensions } from "./extensions/loader.ts";
export {
  BUNDLED_EXTENSIONS,
  bundled,
  type ExtensionChoice,
  type ExtensionSetup,
  listExtensionSetups,
  saveExtensionSetups,
  sealConfigSecrets,
} from "./extensions/settings.ts";
// What extensions and hosts need from Pi, so they depend on @nudge/core alone and a Pi upgrade
// touches only this package (ADR 1). Tests take the faux provider from @nudge/core/testing.
export type { Context } from "@earendil-works/chord";
export { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
export {
  type Api,
  type AssistantMessage,
  type Context as ModelContext,
  type Message,
  type Model,
  type Models,
  type ThinkingLevel,
  type ToolResultMessage,
  Type,
  type Usage,
} from "@earendil-works/pi-ai";
export { builtinModels } from "@earendil-works/pi-ai/providers/all";
export {
  type Conversation,
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  type Cursor,
  defineDoc,
  defineDocFamily,
  defineTask,
  defineTool,
  type DocumentReader,
  type DocumentWatch,
  type EntryId,
  type EntryRecord,
  hook,
  type InboxItem,
  type InboxState,
  type JsonObject,
  LiveDoc,
  type LiveState,
  NestedCallDoc,
  type NestedToolExecutionResult,
  section,
  type SessionDocFamilyToken,
  type SessionDocToken,
  type Task,
  type TaskId,
  type TaskRuntime,
  type ToolExecutionApi,
  type ToolRegistration,
  type ToolSlot,
  ToolTask,
  type ToolTaskResult,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
export {
  CODEMODE_TOOL_NAME,
  createCodemodeExtension,
  createCodemodeTool,
} from "@earendil-works/pi-durable/codemode";
export { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
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
  LAST_USED_EVERY_MS,
  LOBBY,
  type PairingRecord,
  type SideConversation,
  type Player,
  type PlayerHome,
  addressOf,
  assistantAddressOf,
  parseAddress,
  parseAssistantAddress,
  sameHome,
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
export {
  InvalidProfile,
  MAX_AVATAR_LENGTH,
  type NotificationPrefs,
  type Profile,
  ProfileDoc,
  profileOf,
  Profiles,
  type ProfileUpdate,
} from "./identity/profiles.ts";
export {
  InvalidPersonal,
  locationText,
  type LocationUpdate,
  MAX_PERSONAL_LENGTH,
  PERSONAL_FIELDS,
  Personal,
  type PersonalDetails,
  PersonalDoc,
  type PersonalField,
  type PersonalUpdate,
} from "./identity/personal.ts";
export { Rooms, type SharedRoomDraft } from "./identity/rooms.ts";
export {
  ACCESSORIES,
  type Appearance,
  EYE_SHAPES,
  InvalidAppearance,
  Looks,
} from "./identity/appearance.ts";
export { scrubSecrets, SecretStore } from "./secrets.ts";
export { type NudgeDraft, Nudges } from "./nudges/nudges.ts";
export { formatTime, parseTime, ScheduleDoc, type ScheduledNudge } from "./nudges/schedule.ts";
export { FIRE_ENTRY, type FireEntryData, NudgeTimer } from "./nudges/timer-task.ts";
export { buildModels } from "./models/providers.ts";
export { RedactingModels, type RedactionOptions } from "./models/redacting-models.ts";
export { type ModelError, ModelErrors, type ModelFailure } from "./models/model-errors.ts";
export {
  createLogger,
  errorFields,
  LOG_LEVELS,
  type LogFields,
  type LogFormat,
  type Logger,
  type LoggerOptions,
  loggerFromEnv,
  type LogLevel,
  scrubLog,
} from "./log.ts";
export {
  builtinDetectors,
  type PiiDetector,
  quasiIdentifierDetectors,
  regexDetector,
  secretDetector,
  type Span,
} from "./privacy/detectors.ts";
export { addressDetector, nameDetector } from "./privacy/people.ts";
export { AMBIGUOUS, CUES, FIRST_NAMES, LAST_NAMES } from "./privacy/name-lists.ts";
export { PLACEHOLDER, Vault, type VaultEntry } from "./privacy/vault.ts";
export {
  type DeepDetector,
  type DeepFinding,
  DeepUnavailable,
  pendingDeepDetector,
} from "./privacy/deep/detector.ts";
export { DeepScanner, type DeepMode, piecesOf, textsToScan } from "./privacy/deep/scanner.ts";
export {
  checkLocalModel,
  ensureLocalModel,
  LOCAL_MODEL,
  localModelDir,
  openLocalModel,
  startLocalModel,
} from "./privacy/deep/local-model.ts";
export { keepsPlaceholders } from "./privacy/tool-values.ts";
export {
  isUntrusted,
  returnsUntrusted,
  UNTRUSTED_RULE,
  untrustedData,
  untrustedSources,
  withoutPartialMarker,
  withoutUntrustedMarkers,
} from "./privacy/untrusted.ts";
export { canRead, onlyReads, readsOnly } from "./extensions/reads.ts";
export type { RedactedHistory };
export {
  actingFor,
  currentTurn,
  inTurn,
  type Owner,
  type SetsTurn,
  hostsIn,
  type Turn,
  turnOf,
} from "./privacy/turn.ts";
export {
  distanceMeters,
  type Geo,
  type GeoPlace,
  type GeoPoint,
  type GeoRoute,
  type GeoCoverage,
  type GeoStep,
  GeoUnavailable,
  providedGeo,
  provideGeo,
  type TravelMode,
} from "./geo/geo.ts";
export { type GeoEndpoints, graphhopperRoute, httpGeo, photonPlaces } from "./geo/http.ts";
export {
  checkGeo,
  type GeoRegionStatus,
  type GeoStatus,
  graphhopperConfig,
  reason as processFailure,
  ServerGeo,
  type ServerGeoOptions,
} from "./server/geo.ts";
export {
  contains,
  type GeoRegion,
  type GeoSource,
  parseGeofabrik,
  placeRegions,
  regionFor,
  regionsAt,
  sourcesFor,
} from "./server/geo-catalog.ts";
export {
  type DatabaseEncryption,
  type DatabaseKey,
  DatabaseKeyError,
  databaseEncryption,
  databaseKey,
  decryptDatabase,
  encryptDatabase,
  keyFile,
  snapshotDatabase,
} from "./encrypted-storage.ts";
export { DatabaseInUse, databaseHolder, lockDatabase } from "./storage-lock.ts";
export {
  type BrokenExtension,
  ExtensionBroken,
  ExtensionNotFound,
  type InstalledExtension,
  NotAllowed,
  Nudge,
  type NudgeOptions,
  type PrivacyOptions,
  type PrivateValue,
  type PlayerSettingsSchema,
  RETIRE_TIMEOUT_MS,
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
 * assistants. History stored under older detectors is rewritten first (`redactWhenOutdated`).
 */
export async function openAssistant(
  config: NudgeConfig,
  assistant: AssistantConfig,
  context: Context,
  overrides: Partial<NudgeOptions> & { models?: Models } = {},
): Promise<Nudge> {
  const options = await assistantOptions(config, assistant, overrides);
  await redactWhenOutdated(options, (o, c) => Nudge.open(o, c), context);
  return Nudge.open(options, context);
}

/**
 * Rewrites a configured assistant's database from before ADR 9 with placeholders; see
 * `redactHistory`. Needs the database to itself.
 */
export async function redactStoredHistory(
  config: NudgeConfig,
  assistant: AssistantConfig,
  context: Context,
  overrides: Partial<NudgeOptions> = {},
): Promise<RedactedHistory> {
  return redactHistory(
    await assistantOptions(config, assistant, overrides),
    (options, openContext) => Nudge.open(options, openContext),
    context,
  );
}

async function assistantOptions(
  config: NudgeConfig,
  assistant: AssistantConfig,
  overrides: Partial<NudgeOptions> & { models?: Models },
): Promise<NudgeOptions> {
  return {
    name: assistant.name,
    database: assistant.database ?? ":memory:",
    models: overrides.models ?? buildModels(config.providers),
    model: assistant.model ?? DEFAULT_MODEL,
    displayName: assistant.displayName ?? capitalize(assistant.name),
    timeZone: assistant.timeZone,
    instructions:
      assistant.instructions === undefined ? undefined : renderInstructions(assistant.instructions),
    ...(assistant.style === undefined ? {} : { style: assistant.style }),
    ...(assistant.autonomy === undefined ? {} : { autonomy: assistant.autonomy }),
    extensions: await loadExtensions(assistant.extensions ?? []),
    ...(assistant.budget === undefined ? {} : { budget: assistant.budget }),
    ...overrides,
    privacy: {
      ...(config.privacy?.deep === undefined ? {} : { deepMode: config.privacy.deep }),
      ...(config.privacy?.allow === undefined ? {} : { allow: config.privacy.allow }),
      ...overrides.privacy,
    },
  };
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
