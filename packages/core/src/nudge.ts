import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  createRegistry,
  Harness,
  type HarnessSettings,
  MemoryStorage,
  type ModelRef,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export type NudgeOptions = {
  /** Where the assistant lives: a SQLite file path, or `":memory:"` for nothing persisted. */
  readonly database: string;
  /** Model catalog and credentials every request goes through. */
  readonly models: Models;
  /** Model new conversations run with. */
  readonly model: ModelRef;
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
  ) {}

  static async open(options: NudgeOptions, context: Context): Promise<Nudge> {
    const storage = await openStorage(options.database);
    const harness = await Harness.open(
      storage,
      {
        models: options.models,
        registry: createRegistry(),
        settings: options.settings,
        now: options.now,
        onReport: options.onReport,
      },
      context,
    );
    const lobby = await harness.root(context, { agent: { model: options.model } });
    harness.resume();
    return new Nudge(harness, lobby);
  }

  /** The assistant's root conversation, which every player shares until rooms exist. */
  get lobbyId(): ConversationId {
    return this.lobby.id;
  }

  async close(context: Context): Promise<void> {
    await this.harness.close(context);
  }
}

async function openStorage(database: string): Promise<Storage> {
  if (database === ":memory:") return new MemoryStorage();
  await mkdir(dirname(database), { recursive: true });
  return openNodeSqliteStorage(database);
}
