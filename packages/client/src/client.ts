import type { Attachment, MessageResponse, WhenBusy } from "@nudge/protocol";
import { Api, ApiError, type TokenStore } from "./api.ts";
import { Connection, type ConnectionOptions, connectUrl } from "./connection.ts";
import { type KeyValueStorage, memoryStorage, Outbox, type Outgoing } from "./outbox.ts";
import { type PendingMessage, RoomListStore, RoomStore } from "./stores.ts";

export type NudgeClientOptions = {
  /** The server's address, such as `https://nudge.example`; `""` for the page's own origin. */
  readonly server: string;
  readonly assistant: string;
  readonly tokens: TokenStore;
  /** What this client is: sent in the socket's hello. */
  readonly client: ConnectionOptions["client"];
  readonly fetch?: typeof fetch;
  /**
   * Where the outbox is kept, such as `localStorage`, so messages that didn't get through survive
   * a reload; in memory only without one.
   */
  readonly storage?: KeyValueStorage;
} & Pick<ConnectionOptions, "socket" | "backoff" | "heartbeatMs" | "onError">;

/** How long to wait after a rate limit that gave no `Retry-After`. */
const RATE_LIMIT_WAIT_S = 10;

/** A store held open: call `release` when done with it. */
export type Lease<S> = { readonly store: S; release(): void };

/**
 * A client of one assistant: its HTTP commands (`api`), its socket (`connection`), the stores of
 * the views in use, shared by everyone who holds them, and an outbox. A view is subscribed while
 * at least one lease on it is held. `send` puts a message in the outbox and shows it in its room's
 * store until the view has it; one that doesn't get through (no network, or a 5xx) is sent again
 * with the same `requestId` whenever the socket opens and on `retryNow`, also after a reload when
 * the outbox is in a `storage`, and one the server rate limited once its `Retry-After` is up. The
 * server answers a `requestId` it has seen with the same submission, so a message sent twice still
 * shows once.
 */
export class NudgeClient {
  readonly api: Api;
  readonly connection: Connection;
  readonly outbox: Outbox;
  private readonly held = new Map<
    string,
    { store: RoomStore | RoomListStore; leases: number; unwatch: () => void }
  >();
  /** Messages on their way to the server, by `requestId`, so none is posted twice at once. */
  private readonly posting = new Map<string, Promise<MessageResponse>>();
  private delivering: Promise<void> | undefined;
  /** Sends the outbox again once a rate limit's `Retry-After` is up. */
  private rateLimitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: NudgeClientOptions) {
    const { server, assistant, tokens } = options;
    this.api = new Api({
      server,
      assistant,
      tokens,
      ...(options.fetch && { fetch: options.fetch }),
    });
    this.connection = new Connection({
      url: connectUrl(server, assistant),
      token: () => tokens.get(),
      client: options.client,
      ...(options.socket && { socket: options.socket }),
      ...(options.backoff && { backoff: options.backoff }),
      ...(options.heartbeatMs !== undefined && { heartbeatMs: options.heartbeatMs }),
      ...(options.onError && { onError: options.onError }),
    });
    this.outbox = new Outbox(options.storage ?? memoryStorage(), outboxKey(server, assistant));
    this.connection.subscribe(() => {
      const status = this.connection.getStatus();
      if (status.kind !== "open") return;
      this.claim(status.welcome.player.id);
      void this.deliverWaiting();
    });
  }

  /** The player's room list. */
  roomList(): Lease<RoomListStore> {
    return this.hold("rooms", () => new RoomListStore()) as Lease<RoomListStore>;
  }

  /** A room's view, with its earlier items and this client's pending messages. */
  room(id: string): Lease<RoomStore> {
    return this.hold(`room:${id}`, () => {
      const store = new RoomStore(
        id,
        (page) => this.api.timeline(id, page),
        (requestId) => this.outbox.remove(requestId),
      );
      for (const message of this.outbox.list(id)) store.sending(pending(message));
      return store;
    }) as Lease<RoomStore>;
  }

  /**
   * Posts a message, shown as pending in the room's store (when one is held) until the view has
   * it. On failure the pending message keeps the error and the promise rejects: one that didn't
   * get through stays in the outbox and goes again by itself, one the server refused waits for
   * `resend` (the same `requestId` again, which the server answers with the same submission) or
   * `dismiss`.
   */
  send(
    room: string,
    text: string,
    options: {
      whenBusy?: WhenBusy;
      requestId?: string;
      private?: boolean;
      /** Uploaded with `api.uploadAttachment` and not sent yet; `text` may then be empty. */
      attachments?: readonly Attachment[];
    } = {},
  ): Promise<MessageResponse> {
    const { whenBusy, attachments } = options;
    const message: Outgoing = {
      requestId: options.requestId ?? newRequestId(),
      room,
      text,
      ...(whenBusy && { whenBusy }),
      ...(options.private === true && { private: true }),
      ...(attachments !== undefined && attachments.length > 0 && { attachments }),
      createdAt: Date.now(),
    };
    this.outbox.put(message);
    this.storeOf(room)?.sending(pending(message));
    return this.post(message);
  }

  /** Sends a pending message of `room` again. */
  resend(room: string, requestId: string): Promise<MessageResponse> {
    const message =
      this.outbox.list(room).find((m) => m.requestId === requestId) ??
      this.storeOf(room)
        ?.getState()
        .pending.find((p) => p.requestId === requestId);
    if (message === undefined) throw new Error(`No pending message "${requestId}"`);
    return this.send(room, message.text, {
      requestId,
      ...(message.whenBusy && { whenBusy: message.whenBusy }),
      ...(message.private === true && { private: true }),
      ...(message.attachments !== undefined && { attachments: message.attachments }),
    });
  }

  /** Drops a pending message: it leaves the outbox, and the room's store stops showing it. */
  dismiss(room: string, requestId: string): void {
    this.outbox.remove(requestId);
    this.storeOf(room)?.dismiss(requestId);
  }

  /**
   * Tries again now rather than on the next backoff, such as when the network comes back or the
   * page is shown again: reconnects when waiting to, and sends the outbox when open.
   */
  retryNow(): void {
    if (this.connection.getStatus().kind === "open") void this.deliverWaiting();
    else this.connection.retryNow();
  }

  /**
   * Sends the outbox's messages that didn't get through, oldest first, until one doesn't get
   * through again. Done whenever the socket opens.
   */
  deliverWaiting(): Promise<void> {
    // Cleared in a `.finally` rather than inside: with nothing to send, the body ends before
    // `delivering` is set, which would leave it set for good and every later call a no-op.
    this.delivering ??= (async () => {
      for (const message of this.outbox.list()) {
        if (message.error !== undefined) continue;
        try {
          await this.post(message);
        } catch (error) {
          if (retryable(error)) return;
        }
      }
    })().finally(() => {
      this.delivering = undefined;
    });
    return this.delivering;
  }

  /** Connects the socket; views held now or later are subscribed once it is open. */
  open(): void {
    this.connection.open();
  }

  /** Closes the socket; leases stay, and are subscribed again by `open()`. */
  close(): void {
    clearTimeout(this.rateLimitTimer);
    this.rateLimitTimer = undefined;
    this.connection.close();
  }

  /**
   * Sends the outbox again when the rate limit lets it, while the socket is open; returns in how
   * many seconds.
   */
  private retryAfter(error: ApiError): number {
    const seconds = error.retryAfter ?? RATE_LIMIT_WAIT_S;
    if (this.rateLimitTimer !== undefined) return seconds;
    this.rateLimitTimer = setTimeout(() => {
      this.rateLimitTimer = undefined;
      if (this.connection.getStatus().kind === "open") void this.deliverWaiting();
    }, seconds * 1000);
    return seconds;
  }

  private post(message: Outgoing): Promise<MessageResponse> {
    const posting = this.posting.get(message.requestId);
    if (posting !== undefined) return posting;
    const { requestId, room, text, whenBusy, attachments } = message;
    const post = this.api
      .send(room, {
        text,
        requestId,
        ...(whenBusy && { whenBusy }),
        ...(message.private === true && { private: true }),
        ...(attachments !== undefined && { attachments: attachments.map((a) => a.id) }),
      })
      .then(
        (response) => {
          this.outbox.remove(requestId);
          return response;
        },
        (error: unknown) => {
          let reason = (error as Error).message;
          if (!retryable(error)) this.outbox.refused(requestId, reason);
          else if (error instanceof ApiError && error.rateLimited)
            reason = `Too many requests; sending again in ${this.retryAfter(error)} s`;
          this.storeOf(room)?.failed(requestId, reason);
          throw error;
        },
      )
      .finally(() => this.posting.delete(requestId));
    this.posting.set(requestId, post);
    return post;
  }

  /** Makes the outbox the signed-in player's, and stops showing another player's messages. */
  private claim(player: string): void {
    const before = this.outbox.list();
    this.outbox.claim(player);
    if (this.outbox.list().length === before.length) return;
    for (const message of before) this.storeOf(message.room)?.dismiss(message.requestId);
  }

  private storeOf(room: string): RoomStore | undefined {
    return this.held.get(`room:${room}`)?.store as RoomStore | undefined;
  }

  private hold(target: "rooms" | `room:${string}`, make: () => RoomStore | RoomListStore) {
    let entry = this.held.get(target);
    if (entry === undefined) {
      const store = make();
      entry = { store, leases: 0, unwatch: this.connection.watch(target, store) };
      this.held.set(target, entry);
    }
    entry.leases += 1;
    const held = entry;
    let released = false;
    return {
      store: held.store,
      release: () => {
        if (released) return;
        released = true;
        held.leases -= 1;
        if (held.leases > 0) return;
        held.unwatch();
        this.held.delete(target);
      },
    };
  }
}

/** The key a client of `assistant` on `server` keeps its outbox under in its `storage`. */
export function outboxKey(server: string, assistant: string): string {
  const origin = server.replace(/\/+$/, "");
  return `nudge.outbox:${origin === "" ? "" : `${origin}:`}${assistant}`;
}

/**
 * Whether sending again may work: the request didn't get through, the server failed, or it asked
 * the client to slow down. A spent budget is no reason to send again.
 */
function retryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500 || error.rateLimited;
}

function pending(message: Outgoing): PendingMessage {
  const { requestId, text, whenBusy, attachments, error } = message;
  return {
    requestId,
    text,
    ...(whenBusy && { whenBusy }),
    ...(message.private === true && { private: true }),
    ...(attachments !== undefined && { attachments }),
    ...(error !== undefined && { error }),
  };
}

/** A random id, from `getRandomValues`, which pages served over plain HTTP have too. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
