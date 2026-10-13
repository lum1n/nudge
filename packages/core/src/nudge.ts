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
  createRegistry,
  type Extension,
  Harness,
  type HarnessSettings,
  MemoryStorage,
  type ModelRef,
  type Storage,
  type Submission,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBuiltinExtension } from "./extensions/builtin.ts";
import { attach, type MessageDraft, submitMessage } from "./host-api.ts";
import { DirectoryDoc, type Room } from "./identity/directory.ts";
import { Players } from "./identity/players.ts";
import { Rooms } from "./identity/rooms.ts";
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
  readonly extensions?: readonly Extension[];
  readonly settings?: HarnessSettings;
  readonly privacy?: PrivacyOptions;
  /** Clock for timestamps and timers; tests inject a fake one. */
  readonly now?: () => number;
  readonly onReport?: (error: unknown) => void;
};

/** One assistant: one storage, one Harness, one registry. */
export class Nudge {
  readonly players: Players;
  readonly rooms: Rooms;

  private constructor(
    readonly harness: Harness,
    /** What the assistant calls itself. */
    readonly displayName: string,
    private readonly models: RedactingModels,
    agent: AgentChange,
    private readonly now: () => number,
    private readonly unlock: () => Promise<void>,
  ) {
    this.players = new Players(harness, (name) => this.protect(name, "NAME").then(() => {}), now);
    this.rooms = new Rooms(harness, () => agent, now);
  }

  static async open(options: NudgeOptions, context: Context): Promise<Nudge> {
    const now = options.now ?? Date.now;
    const registry = createRegistry();
    registry.install(
      createBuiltinExtension({
        displayName: options.displayName ?? "Nudge",
        timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        now,
      }),
    );
    for (const extension of options.extensions ?? []) registry.install(extension);
    const models = new RedactingModels(options.models, {
      detectors: options.privacy?.detectors ?? builtinDetectors,
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
      const nudge = new Nudge(harness, options.displayName ?? "Nudge", models, agent, now, unlock);
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
      harness.resume();
      return nudge;
    } catch (error) {
      await harness.close(context);
      await unlock();
      throw error;
    }
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
