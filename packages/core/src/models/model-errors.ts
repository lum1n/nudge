import { scrubLog } from "../log.ts";

/** A request to a model provider that failed, as `RedactingModels` saw it. */
export type ModelFailure = {
  readonly provider: string;
  readonly model: string;
  /** The provider's answer, with placeholders where personal values were. */
  readonly message: string;
};

/** A failure as a host keeps it: when, and for which assistant. */
export type ModelError = ModelFailure & { readonly at: number; readonly assistant?: string };

/** Longest message kept: a provider's error can carry a whole request back. */
const MESSAGE_LIMIT = 300;

/**
 * The last few model errors a host's assistants hit, newest first, for owners to see and for the
 * health check's age of the last one. Messages are scrubbed and cut short when recorded.
 */
export class ModelErrors {
  private readonly kept: ModelError[] = [];

  constructor(
    private readonly capacity = 20,
    private readonly now: () => number = Date.now,
  ) {}

  record(failure: ModelFailure & { readonly assistant?: string }): ModelError {
    let message = scrubLog(failure.message);
    if (message.length > MESSAGE_LIMIT) message = `${message.slice(0, MESSAGE_LIMIT - 1)}…`;
    const error: ModelError = { ...failure, message, at: this.now() };
    this.kept.unshift(error);
    if (this.kept.length > this.capacity) this.kept.length = this.capacity;
    return error;
  }

  /** Newest first. */
  recent(): readonly ModelError[] {
    return [...this.kept];
  }

  /** When the last one happened, in ms since the epoch; undefined before any. */
  lastAt(): number | undefined {
    return this.kept[0]?.at;
  }
}
