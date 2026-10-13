import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  createRegistry,
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
  readonly settings?: HarnessSettings;
  /** Clock for timestamps and timers; tests inject a fake one. */
  readonly now?: () => number;
  readonly onReport?: (error: unknown) => void;
};

/** One assistant: one storage, one Harness, one registry. */
export class Nudge {
  private constructor(
    readonly harness: Harness,
    private readonly lobby: Conversation,
    private readonly now: () => number,
  ) {}

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
    const storage = await openStorage(options.database);
    const harness = await Harness.open(
      storage,
      {
        models: options.models,
        registry,
        settings: options.settings,
        now: options.now,
        onReport: options.onReport,
      },
      context,
    );
    try {
      const lobby = await harness.root(context, {
        agent: { model: options.model, instructions: options.instructions ?? null },
      });
      await followConfig(lobby, options, context);
      harness.resume();
      return new Nudge(harness, lobby, now);
    } catch (error) {
      await harness.close(context);
      throw error;
    }
  }

  /** The assistant's root conversation, which every player shares until rooms exist. */
  get lobbyId(): ConversationId {
    return this.lobby.id;
  }

  submit(
    conversationId: ConversationId,
    draft: MessageDraft,
    context: Context,
  ): Promise<Submission> {
    return submitMessage(this.harness, conversationId, draft, this.now(), context);
  }

  attach(conversationId: ConversationId, context: Context): Promise<AgentEventStream> {
    return attach(this.harness, conversationId, context);
  }

  async close(context: Context): Promise<void> {
    await this.harness.close(context);
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
  await mkdir(dirname(database), { recursive: true });
  return openNodeSqliteStorage(database);
}
