import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type ConversationWatch,
  createRegistry,
  Harness,
  type HarnessSettings,
  MemoryStorage,
  type ModelRef,
  type Registry,
  type Storage,
  type Submission,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBuiltinExtension } from "./extensions/builtin.ts";
import {
  type HostBase,
  type ExtensionInput,
  type RoomSocketHandler,
  type SetUpExtension,
  setUpExtension,
} from "./extensions/define.ts";
import { attach, type MessageDraft, submitMessage } from "./host-api.ts";
import { DirectoryDoc, type Room } from "./identity/directory.ts";
import { Players } from "./identity/players.ts";
import { Rooms } from "./identity/rooms.ts";
import { Memory } from "./memory/memory.ts";
import { Nudges } from "./nudges/nudges.ts";
import { RedactingModels, type RedactionOptions } from "./models/redacting-models.ts";
import { builtinDetectors, type PiiDetector } from "./privacy/detectors.ts";
import { Vault } from "./privacy/vault.ts";
import { VaultDoc } from "./privacy/vault-doc.ts";
import { lockDatabase } from "./storage-lock.ts";

export type PrivacyOptions = {
  /** Detectors to run instead of the built-in ones. Names are protected separately. */
  readonly detectors?: readonly PiiDetector[];
  readonly onRequest?: RedactionOptions["onRequest"];
};

export type NudgeOptions = {
  /** Where the assistant lives: a SQLite file path, or `":memory:"` for nothing persisted. */
  readonly database: string;
  /** Model catalog and credentials every request goes through. */
  readonly models: Models;
  /** Model the assistant runs with. */
  readonly model: ModelRef;
  /** What the assistant calls itself. Default "Nudge". */
  readonly displayName?: string;
  /** IANA time zone. Default: the host's. */
  readonly timeZone?: string;
  /** Extra instructions, rendered last in the system prompt. */
  readonly instructions?: string;
  /** Extensions installed after the built-in one, in order. */
  readonly extensions?: readonly ExtensionInput[];
  readonly settings?: HarnessSettings;
  readonly privacy?: PrivacyOptions;
  /** Clock for timestamps and timers; tests inject a fake one. */
  readonly now?: () => number;
  readonly onReport?: (error: unknown) => void;
};

/** An installed extension, as `Nudge.extensions` lists it. */
export type InstalledExtension = { readonly name: string; readonly version?: string };

type Parts = {
  readonly harness: Harness;
  readonly displayName: string;
  readonly models: RedactingModels;
  readonly agent: AgentChange;
  readonly now: () => number;
  readonly unlock: () => Promise<void>;
  readonly registry: Registry;
  readonly host: HostBase;
  readonly detectors: readonly PiiDetector[];
  readonly installed: readonly SetUpExtension[];
};

/** One assistant: one storage, one Harness, one registry. */
export class Nudge {
  readonly harness: Harness;
  /** What the assistant calls itself. */
  readonly displayName: string;
  readonly players: Players;
  readonly rooms: Rooms;
  readonly nudges: Nudges;
  readonly memory: Memory;
  private readonly models: RedactingModels;
  private readonly now: () => number;
  private readonly unlock: () => Promise<void>;
  private readonly registry: Registry;
  private readonly host: Parts["host"];
  /** The assistant's own detectors, without its extensions'. */
  private readonly detectors: readonly PiiDetector[];
  private installed: readonly SetUpExtension[];
  private reloading: Promise<unknown> = Promise.resolve();

  private constructor(parts: Parts) {
    const { harness, agent, now } = parts;
    this.harness = harness;
    this.displayName = parts.displayName;
    this.models = parts.models;
    this.now = now;
    this.unlock = parts.unlock;
    this.registry = parts.registry;
    this.host = parts.host;
    this.detectors = parts.detectors;
    this.installed = parts.installed;
    this.players = new Players(harness, (name) => this.protect(name, "NAME").then(() => {}), now);
    this.rooms = new Rooms(harness, () => agent, now);
    this.nudges = new Nudges(harness, this.rooms, now);
    this.memory = new Memory(harness, this.rooms, now);
  }

  static async open(options: NudgeOptions, context: Context): Promise<Nudge> {
    const now = options.now ?? Date.now;
    const displayName = options.displayName ?? "Nudge";
    const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const registry = createRegistry();
    let opened: Nudge | undefined;
    const whenOpen = () => {
      if (opened === undefined) throw new Error("The assistant is not open yet");
      return opened;
    };
    registry.install(
      createBuiltinExtension({ displayName, timeZone, now, nudges: () => whenOpen().nudges }),
    );
    const host: Parts["host"] = {
      displayName,
      timeZone,
      now,
      protect: (value, kind) => whenOpen().protect(value, kind),
      ...(options.database === ":memory:" ? {} : { dataRoot: `${options.database}.extensions` }),
    };
    // Extensions are in the registry before the Harness opens, so their tasks resume with it.
    const installed = await setUpAll(options.extensions ?? [], host);
    for (const { extension } of installed) registry.install(extension);
    const detectors = options.privacy?.detectors ?? builtinDetectors;
    const models = new RedactingModels(options.models, {
      detectors: withExtensionDetectors(detectors, installed),
      onRequest: options.privacy?.onRequest,
    });
    if (options.database !== ":memory:")
      await mkdir(dirname(options.database), { recursive: true });
    const unlock =
      options.database === ":memory:" ? async () => {} : await lockDatabase(options.database);
    let harness: Harness;
    try {
      harness = await Harness.open(
        await openStorage(options.database),
        {
          models,
          registry,
          settings: options.settings,
          now: options.now,
          onReport: options.onReport,
        },
        context,
      );
    } catch (error) {
      await unlock();
      throw error;
    }
    try {
      const saved = await harness.snapshot(VaultDoc, context);
      models.bind(new Vault(saved?.entries ?? []), (entries) =>
        harness.commit(async (tx) => {
          (await tx.doc(VaultDoc)).entries.push(...entries.map((entry) => ({ ...entry })));
        }, BACKGROUND_CONTEXT),
      );
      const agent: AgentChange = {
        model: options.model,
        instructions: options.instructions ?? null,
      };
      const lobby = await harness.root(context, { agent });
      const nudge = new Nudge({
        harness,
        displayName,
        models,
        agent,
        now,
        unlock,
        registry,
        host,
        detectors,
        installed,
      });
      await nudge.rooms.adoptLobby(lobby.id, context);
      const directory = await harness.snapshot(DirectoryDoc, context);
      // Names stored before redaction existed, or before a vault was lost, go back in.
      for (const player of Object.values(directory?.players ?? {}))
        models.vault.protect(player.displayName, "NAME");
      await models.flush();
      for (const room of Object.values(directory?.rooms ?? {})) {
        const conversation = await harness.conversation(
          room.conversationId as ConversationId,
          context,
        );
        if (conversation !== undefined) await followConfig(conversation, options, context);
      }
      await nudge.nudges.reconcile(context);
      opened = nudge;
      // Pending nudge timers rearm here; those whose time passed while the host was down fire now.
      harness.resume();
      return nudge;
    } catch (error) {
      await harness.close(context);
      await unlock();
      throw error;
    }
  }

  /** The extensions installed after the built-in one, in order. */
  extensions(): InstalledExtension[] {
    return this.installed.map(({ extension, version }) => ({
      name: extension.name,
      ...(version === undefined ? {} : { version }),
    }));
  }

  /**
   * Installs `extensions` in place of the current ones: same names are replaced, new ones added,
   * missing ones removed. Every extension is set up first, so one that fails changes nothing.
   * Conversations pick the change up at their next turn.
   */
  reloadExtensions(extensions: readonly ExtensionInput[]): Promise<InstalledExtension[]> {
    const reload = this.reloading.then(async () => {
      const next = await setUpAll(extensions, this.host);
      const names = new Set(next.map(({ extension }) => extension.name));
      for (const { extension } of this.installed)
        if (!names.has(extension.name)) this.registry.uninstall(extension);
      for (const { extension } of next) this.registry.install(extension);
      this.models.detectors = withExtensionDetectors(this.detectors, next);
      this.installed = next;
      return this.extensions();
    });
    this.reloading = reload.catch(() => {});
    return reload;
  }

  /** The room socket an installed extension serves, if any. */
  roomSocket(extension: string): RoomSocketHandler | undefined {
    return this.installed.find((installed) => installed.extension.name === extension)?.roomSocket;
  }

  /** The room's conversation, for what the room API does not cover. */
  async conversation(roomId: string, context: Context): Promise<Conversation> {
    const room = await this.room(roomId, context);
    const conversation = await this.harness.conversation(
      room.conversationId as ConversationId,
      context,
    );
    if (conversation === undefined) throw new Error(`Room "${roomId}" has no conversation`);
    return conversation;
  }

  /** Posts a message to a room. Checking that the author may use the room is the host's job. */
  async submit(roomId: string, draft: MessageDraft, context: Context): Promise<Submission> {
    const room = await this.room(roomId, context);
    // The model sees "<name>: <text>"; the name is personal, so it goes to the vault first.
    if (draft.author !== undefined) this.models.vault.protect(draft.author.displayName, "NAME");
    return submitMessage(
      this.harness,
      room.conversationId as ConversationId,
      draft,
      this.now(),
      context,
    );
  }

  /** Stops the answer in progress in a room, and drops its queued messages. */
  async abort(roomId: string, context: Context): Promise<void> {
    await (await this.conversation(roomId, context)).abort(context);
  }

  /**
   * Keeps a value from the model, such as an address or a relative's name: from now on it only
   * ever sees the returned placeholder. `kind` is upper-case letters.
   */
  async protect(value: string, kind = "PRIVATE"): Promise<string> {
    const placeholder = this.models.vault.protect(value, kind);
    await this.models.flush();
    return placeholder;
  }

  /** What the model would see for `text`: personal values replaced by placeholders. */
  redact(text: string): string {
    return this.models.vault.redact(text, this.models.detectors);
  }

  async attach(roomId: string, context: Context): Promise<AgentEventStream> {
    const room = await this.room(roomId, context);
    return attach(this.harness, room.conversationId as ConversationId, context);
  }

  /**
   * The room's conversation view: its transcript and live state now, then the Chord ops of every
   * commit that changes it. Holds raw entries and every built-in document, `pi.provider` included.
   */
  async watchRoom(roomId: string, context: Context): Promise<ConversationWatch> {
    return (await this.conversation(roomId, context)).watch(context);
  }

  private async room(roomId: string, context: Context): Promise<Room> {
    const room = await this.rooms.get(roomId, context);
    if (room === undefined) throw new RoomNotFound(roomId);
    return room;
  }

  async close(context: Context): Promise<void> {
    try {
      await this.harness.close(context);
    } finally {
      await this.unlock();
    }
  }
}

export class RoomNotFound extends Error {
  override name = "RoomNotFound";
  constructor(readonly roomId: string) {
    super(`No room "${roomId}"`);
  }
}

async function setUpAll(
  inputs: readonly ExtensionInput[],
  host: Parts["host"],
): Promise<SetUpExtension[]> {
  const installed: SetUpExtension[] = [];
  for (const input of inputs) {
    const setUp = await setUpExtension(input, host);
    if (installed.some(({ extension }) => extension.name === setUp.extension.name))
      throw new Error(`Extension "${setUp.extension.name}" is installed twice`);
    installed.push(setUp);
  }
  return installed;
}

function withExtensionDetectors(
  own: readonly PiiDetector[],
  installed: readonly SetUpExtension[],
): PiiDetector[] {
  return [...own, ...installed.flatMap(({ detectors }) => detectors)];
}

/** The config file is the source of truth: carry a changed model or instructions into the stored agent. */
async function followConfig(
  conversation: Conversation,
  options: NudgeOptions,
  context: Context,
): Promise<void> {
  const agent = await conversation.agent(context);
  const modelChanged =
    agent.model?.provider !== options.model.provider ||
    agent.model?.modelId !== options.model.modelId;
  const instructionsChanged = (agent.instructions ?? undefined) !== options.instructions;
  if (!modelChanged && !instructionsChanged) return;
  await conversation.configure(
    { model: options.model, instructions: options.instructions ?? null },
    context,
  );
}

async function openStorage(database: string): Promise<Storage> {
  if (database === ":memory:") return new MemoryStorage();
  return openNodeSqliteStorage(database);
}
