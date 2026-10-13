import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
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
import { RedactingModels, type RedactionOptions } from "./models/redacting-models.ts";
import { builtinDetectors, type PiiDetector } from "./privacy/detectors.ts";
import { Vault } from "./privacy/vault.ts";
import { VaultDoc } from "./privacy/vault-doc.ts";

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
  private constructor(
    readonly harness: Harness,
    private readonly lobby: Conversation,
    private readonly models: RedactingModels,
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
    for (const extension of options.extensions ?? []) registry.install(extension);
    const models = new RedactingModels(options.models, {
      detectors: options.privacy?.detectors ?? builtinDetectors,
      onRequest: options.privacy?.onRequest,
    });
    const storage = await openStorage(options.database);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: options.settings,
        now: options.now,
        onReport: options.onReport,
      },
      context,
    );
    try {
      const saved = await harness.snapshot(VaultDoc, context);
      models.bind(new Vault(saved?.entries ?? []), (entries) =>
        harness.commit(async (tx) => {
          (await tx.doc(VaultDoc)).entries.push(...entries.map((entry) => ({ ...entry })));
        }, BACKGROUND_CONTEXT),
      );
      const lobby = await harness.root(context, {
        agent: { model: options.model, instructions: options.instructions ?? null },
      });
      await followConfig(lobby, options, context);
      harness.resume();
      return new Nudge(harness, lobby, models, now);
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
    // The model sees "<name>: <text>"; the name is personal, so it goes to the vault first.
    if (draft.author !== undefined) this.models.vault.protect(draft.author.displayName, "NAME");
    return submitMessage(this.harness, conversationId, draft, this.now(), context);
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
