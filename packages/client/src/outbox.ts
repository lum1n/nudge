import type { Attachment, WhenBusy } from "@nudge/protocol";

/**
 * Where an outbox is kept between page loads: the browser's `localStorage` and `sessionStorage`
 * fit as they are; `memoryStorage()` keeps it for as long as the client lasts.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A storage in memory only: the outbox lasts as long as the client. */
export function memoryStorage(): KeyValueStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

/** A message in the outbox: sent, but not yet taken by the server. */
export type Outgoing = {
  readonly requestId: string;
  readonly room: string;
  readonly text: string;
  readonly whenBusy?: WhenBusy;
  readonly private?: boolean;
  /** Uploaded already; the message names them. */
  readonly attachments?: readonly Attachment[];
  /** When it was first sent, in ms since the epoch. */
  readonly createdAt: number;
  /** Why the server refused it; it waits for `resend` or a dismissal rather than going again. */
  readonly error?: string;
};

type Saved = { readonly player?: string; readonly messages: readonly Outgoing[] };

/**
 * The messages a client sent that the server hasn't taken yet, kept in a `KeyValueStorage` under
 * one key, each with its room, so a reload doesn't lose them. Every call reads the storage again,
 * so tabs sharing it see each other's changes; sending one message from two tabs is harmless,
 * since the server answers the same `requestId` with the same submission.
 */
export class Outbox {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly key: string,
  ) {}

  /** The waiting messages, oldest first; only `room`'s when given. */
  list(room?: string): Outgoing[] {
    const { messages } = this.read();
    return room === undefined ? [...messages] : messages.filter((m) => m.room === room);
  }

  /** Adds `message`, or replaces the one with its `requestId`. */
  put(message: Outgoing): void {
    const saved = this.read();
    const rest = saved.messages.filter((m) => m.requestId !== message.requestId);
    this.write({ ...saved, messages: [...rest, message] });
  }

  /** Marks a message as refused by the server, so it isn't sent again by itself. */
  refused(requestId: string, error: string): void {
    const saved = this.read();
    if (!saved.messages.some((m) => m.requestId === requestId)) return;
    const messages = saved.messages.map((m) => (m.requestId === requestId ? { ...m, error } : m));
    this.write({ ...saved, messages });
  }

  remove(requestId: string): void {
    const saved = this.read();
    const messages = saved.messages.filter((m) => m.requestId !== requestId);
    if (messages.length !== saved.messages.length) this.write({ ...saved, messages });
  }

  /** Makes the outbox `player`'s: when it was another player's, their messages go. */
  claim(player: string): void {
    const saved = this.read();
    if (saved.player === player) return;
    this.write({
      player,
      messages: saved.player === undefined ? saved.messages : [],
    });
  }

  /** Forgets every message, such as on signing out. */
  clear(): void {
    try {
      this.storage.removeItem(this.key);
    } catch {
      // A storage that can't be written to keeps nothing anyway.
    }
  }

  private read(): Saved {
    try {
      const saved = JSON.parse(this.storage.getItem(this.key) ?? "null") as Saved | null;
      return Array.isArray(saved?.messages) ? saved : { messages: [] };
    } catch {
      return { messages: [] };
    }
  }

  private write(saved: Saved): void {
    try {
      if (saved.messages.length === 0 && saved.player === undefined)
        this.storage.removeItem(this.key);
      else this.storage.setItem(this.key, JSON.stringify(saved));
    } catch {
      // Full, or not allowed (some private windows): the message is still sent, just not kept.
    }
  }
}
