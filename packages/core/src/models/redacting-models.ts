import {
  type Api,
  type AssistantImages,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type ClassifierApi,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierResult,
  type Context,
  createAssistantMessageEventStream,
  type DeferredHandle,
  type ImageApi,
  type ImageModel,
  type ImagesContext,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsClassifierOptions,
  type ModelsDeferredFetchOptions,
  type ModelsImagesOptions,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { PiiDetector } from "../privacy/detectors.ts";
import { mapStrings, redactContext, rehydrateMessage } from "../privacy/redact.ts";
import type { Vault, VaultEntry } from "../privacy/vault.ts";

export type RedactionOptions = {
  readonly detectors: readonly PiiDetector[];
  /** Sees every request exactly as the provider will, for local debugging. */
  readonly onRequest?: (request: { readonly model: string; readonly context: Context }) => void;
};

type Bound = {
  readonly vault: Vault;
  readonly save: (entries: readonly VaultEntry[]) => Promise<void>;
};

/**
 * A `Models` that only ever sends placeholders for personal values, and puts the values back in
 * what comes back before anything else sees it. Every request Pi Durable makes goes through here:
 * generation, compaction summaries and code mode alike (ADR 0002).
 *
 * New placeholders are saved before the request that uses them is sent, so a crash cannot leave
 * the provider holding a placeholder the vault forgot.
 */
export class RedactingModels implements Models {
  private bound: Bound | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: Models,
    private readonly options: RedactionOptions,
  ) {}

  /** Connects the vault once its storage is open. Requests before this fail. */
  bind(vault: Vault, save: (entries: readonly VaultEntry[]) => Promise<void>): void {
    this.bound = { vault, save };
  }

  get detectors(): readonly PiiDetector[] {
    return this.options.detectors;
  }

  get vault(): Vault {
    if (this.bound === undefined)
      throw new Error("Redaction is not ready: the vault is not loaded yet");
    return this.bound.vault;
  }

  /** Saves new vault entries, in order, and waits until everything added so far is stored. */
  async flush(): Promise<void> {
    const { vault, save } = this.bound ?? this.notReady();
    const entries = vault.takeUnsaved();
    if (entries.length > 0) {
      this.saving = this.saving.then(() =>
        save(entries).catch((error: unknown) => {
          vault.returnUnsaved(entries);
          throw error;
        }),
      );
    }
    const saving = this.saving;
    // A failed save fails the requests waiting on it, not every later one.
    this.saving = saving.catch(() => {});
    await saving;
  }

  // Requests that carry content: redact out, rehydrate back.

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ) {
    return this.relay(model, async () =>
      this.inner.stream(model, await this.prepare(model, context), options),
    );
  }

  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) {
    return this.relay(model, async () =>
      this.inner.streamSimple(model, await this.prepare(model, context), options),
    );
  }

  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ) {
    return this.stream(model, context, options).result();
  }

  completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) {
    return this.streamSimple(model, context, options).result();
  }

  async classify(
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
    options?: ModelsClassifierOptions,
  ): Promise<ClassifierResult> {
    const redact = (text: string) => this.vault.redact(text, this.options.detectors);
    const redacted: ClassifierContext = {
      ...context,
      state: mapStrings(context.state, redact),
      questions: Object.fromEntries(
        Object.entries(context.questions).map(([key, question]) => [
          key,
          {
            ...question,
            instructions: redact(question.instructions),
            criteria: mapStrings(question.criteria, redact),
          } as typeof question,
        ]),
      ),
    };
    await this.flush();
    return this.inner.classify(model, redacted, options);
  }

  async generateImages(
    model: ImageModel<ImageApi>,
    context: ImagesContext,
    options?: ModelsImagesOptions,
  ): Promise<AssistantImages> {
    const redacted: ImagesContext = {
      input: context.input.map((block) =>
        block.type === "text"
          ? { ...block, text: this.vault.redact(block.text, this.options.detectors) }
          : block,
      ),
    };
    await this.flush();
    const result = await this.inner.generateImages(model, redacted, options);
    return {
      ...result,
      output: result.output.map((block) =>
        block.type === "text" ? { ...block, text: this.vault.rehydrate(block.text) } : block,
      ),
    };
  }

  // Requests that only bring content back.

  streamDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredFetchOptions) {
    return this.relay(model, async () => this.inner.streamDeferred(model, handle, options));
  }

  async fetchDeferred(
    model: Model<Api>,
    handle: DeferredHandle,
    options?: ModelsDeferredFetchOptions,
  ) {
    return rehydrateMessage(await this.inner.fetchDeferred(model, handle, options), this.vault);
  }

  // Everything else passes through. Spelled out: `inner` is a class instance, so spreading it
  // would drop its methods.

  getProviders: Models["getProviders"] = () => this.inner.getProviders();
  getProvider: Models["getProvider"] = (id) => this.inner.getProvider(id);
  getModels: Models["getModels"] = (provider) => this.inner.getModels(provider);
  getModel: Models["getModel"] = (provider, id) => this.inner.getModel(provider, id);
  getModelsOfType: Models["getModelsOfType"] = (type, provider) =>
    this.inner.getModelsOfType(type, provider);
  getModelOfType: Models["getModelOfType"] = (type, provider, id) =>
    this.inner.getModelOfType(type, provider, id);
  getAllModels: Models["getAllModels"] = (provider) => this.inner.getAllModels(provider);
  refresh: Models["refresh"] = (options) => this.inner.refresh(options);
  checkAuth: Models["checkAuth"] = (providerId, options) =>
    this.inner.checkAuth(providerId, options);
  getAvailable: Models["getAvailable"] = (providerId, options) =>
    this.inner.getAvailable(providerId, options);
  getAvailableOfType: Models["getAvailableOfType"] = (type, providerId, options) =>
    this.inner.getAvailableOfType(type, providerId, options);
  getAllAvailable: Models["getAllAvailable"] = (providerId, options) =>
    this.inner.getAllAvailable(providerId, options);
  getAuth: Models["getAuth"] = ((target: never, overrides: never) =>
    this.inner.getAuth(target, overrides)) as Models["getAuth"];
  login: Models["login"] = (providerId, type, interaction, options) =>
    this.inner.login(providerId, type, interaction, options);
  logout: Models["logout"] = (providerId, options) => this.inner.logout(providerId, options);
  cancelDeferred: Models["cancelDeferred"] = (model, handle, options) =>
    this.inner.cancelDeferred(model, handle, options);

  private async prepare(model: Model<Api>, context: Context): Promise<Context> {
    const redacted = redactContext(context, this.vault, this.options.detectors);
    await this.flush();
    this.options.onRequest?.({ model: `${model.provider}/${model.id}`, context: redacted });
    return redacted;
  }

  /** Runs `start` and relays its stream with values put back; a failure to start becomes an error event. */
  private relay(
    model: Model<Api>,
    start: () => Promise<AssistantMessageEventStream>,
  ): AssistantMessageEventStream {
    const out = createAssistantMessageEventStream();
    void (async () => {
      try {
        const inner = await start();
        const shown = new Map<number, string>();
        for await (const event of inner) out.push(this.rehydrateEvent(event, shown));
      } catch (error) {
        out.push({ type: "error", reason: "error", error: failedMessage(model, error) });
      }
      out.end();
    })();
    return out;
  }

  private rehydrateEvent(
    event: AssistantMessageEvent,
    shown: Map<number, string>,
  ): AssistantMessageEvent {
    const vault = this.vault;
    switch (event.type) {
      case "done":
        return { ...event, message: rehydrateMessage(event.message, vault) };
      case "error":
        return { ...event, error: rehydrateMessage(event.error, vault) };
      case "text_delta": {
        // Deltas are recomputed from the partial, so a placeholder split across chunks
        // arrives as its value once complete.
        const partial = rehydrateMessage(event.partial, vault, true);
        const block = partial.content[event.contentIndex];
        const text = block?.type === "text" ? block.text : "";
        const before = shown.get(event.contentIndex) ?? "";
        shown.set(event.contentIndex, text);
        return {
          ...event,
          delta: text.startsWith(before) ? text.slice(before.length) : text,
          partial,
        };
      }
      case "text_end":
        shown.set(event.contentIndex, vault.rehydrate(event.content));
        return {
          ...event,
          content: vault.rehydrate(event.content),
          partial: rehydrateMessage(event.partial, vault, true),
        };
      case "toolcall_delta":
        return {
          ...event,
          delta: vault.rehydrate(event.delta),
          partial: rehydrateMessage(event.partial, vault, true),
        };
      case "toolcall_end":
        return {
          ...event,
          toolCall: {
            ...event.toolCall,
            arguments: mapStrings(event.toolCall.arguments, (text) => vault.rehydrate(text)),
          },
          partial: rehydrateMessage(event.partial, vault, true),
        };
      default:
        return { ...event, partial: rehydrateMessage(event.partial, vault, true) };
    }
  }

  private notReady(): never {
    throw new Error("Redaction is not ready: the vault is not loaded yet");
  }
}

function failedMessage(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: `Redaction failed: ${error instanceof Error ? error.message : String(error)}`,
    timestamp: Date.now(),
  };
}
