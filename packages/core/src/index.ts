import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { type AssistantConfig, ConfigError, DEFAULT_MODEL, type NudgeConfig } from "./config.ts";
import { loadExtensions } from "./extensions/loader.ts";
import { buildModels } from "./models/providers.ts";
import {
  type RedactedHistory,
  redactHistory,
  redactWhenOutdated,
} from "./privacy/redact-history.ts";
import {
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
  ConfigError,
  ConfigMissing,
  DEFAULT_CONFIG,
  DEFAULT_MODEL,
  type ExtensionConfig,
  type LocalProviderConfig,
  loadConfig,
  type ModelChoice,
  type NudgeConfig,
  parseConfig,
  type ServerSettings,
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
  createBackup,
  lastBackupAt,
  pruneBackups,
  readBackupManifest,
  restoreBackup,
} from "./backup.ts";
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
export { Presence } from "./presence.ts";
export { describeRoom, formatToday } from "./extensions/builtin.ts";
export {
  defineNudgeExtension,
  ROOMS_SETTING,
  roomsSetting,
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
} from "./extensions/settings.ts";
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
export { canRead, onlyReads, readsOnly } from "./extensions/reads.ts";
export type { RedactedHistory };
export {
  currentTurn,
  inTurn,
  type Owner,
  type SetsTurn,
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
export { DatabaseInUse, lockDatabase } from "./storage-lock.ts";
export {
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
    instructions: assistant.instructions,
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
