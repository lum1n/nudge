import type { MessageResponse, WhenBusy } from "@nudge/protocol";
import { Api, type TokenStore } from "./api.ts";
import { Connection, type ConnectionOptions, connectUrl } from "./connection.ts";
import { HomeStore, RoomStore } from "./stores.ts";

export type NudgeClientOptions = {
  /** The server's address, such as `https://nudge.example`; `""` for the page's own origin. */
  readonly server: string;
  readonly assistant: string;
  readonly tokens: TokenStore;
  /** What this client is: sent in the socket's hello. */
  readonly client: ConnectionOptions["client"];
  readonly fetch?: typeof fetch;
} & Pick<ConnectionOptions, "socket" | "backoff" | "heartbeatMs" | "onError">;

/** A store held open: call `release` when done with it. */
export type Lease<S> = { readonly store: S; release(): void };

/**
 * A client of one assistant: its HTTP commands (`api`), its socket (`connection`), and the stores
 * of the views in use, shared by everyone who holds them. A view is subscribed while at least one
 * lease on it is held, and `send` shows a message in its room's store until the view has it.
 */
export class NudgeClient {
  readonly api: Api;
  readonly connection: Connection;
  private readonly held = new Map<
    string,
    { store: RoomStore | HomeStore; leases: number; unwatch: () => void }
  >();

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
  }

  /** The player's home view. */
  home(): Lease<HomeStore> {
    return this.hold("home", () => new HomeStore()) as Lease<HomeStore>;
  }

  /** A room's view, with its earlier items and this client's pending messages. */
  room(id: string): Lease<RoomStore> {
    return this.hold(
      `room:${id}`,
      () => new RoomStore(id, (page) => this.api.timeline(id, page)),
    ) as Lease<RoomStore>;
  }

  /**
   * Posts a message, shown as pending in the room's store (when one is held) until the view has
   * it. On failure the pending message keeps the error and the promise rejects; `resend` tries
   * again with the same `requestId`, which the server answers with the same submission.
   */
  async send(
    room: string,
    text: string,
    options: { whenBusy?: WhenBusy; requestId?: string; private?: boolean } = {},
  ): Promise<MessageResponse> {
    const requestId = options.requestId ?? newRequestId();
    const store = this.storeOf(room);
    const { whenBusy } = options;
    const secret = options.private === true ? { private: true } : {};
    store?.sending({ requestId, text, ...(whenBusy && { whenBusy }), ...secret });
    try {
      return await this.api.send(room, {
        text,
        requestId,
        ...(whenBusy && { whenBusy }),
        ...secret,
      });
    } catch (error) {
      store?.failed(requestId, (error as Error).message);
      throw error;
    }
  }

  /** Sends a pending message of `room` again. */
  resend(room: string, requestId: string): Promise<MessageResponse> {
    const message = this.storeOf(room)
      ?.getState()
      .pending.find((p) => p.requestId === requestId);
    if (message === undefined) throw new Error(`No pending message "${requestId}"`);
    return this.send(room, message.text, {
      requestId,
      ...(message.whenBusy && { whenBusy: message.whenBusy }),
      ...(message.private === true && { private: true }),
    });
  }

  /** Connects the socket; views held now or later are subscribed once it is open. */
  open(): void {
    this.connection.open();
  }

  /** Closes the socket; leases stay, and are subscribed again by `open()`. */
  close(): void {
    this.connection.close();
  }

  private storeOf(room: string): RoomStore | undefined {
    return this.held.get(`room:${room}`)?.store as RoomStore | undefined;
  }

  private hold(target: "home" | `room:${string}`, make: () => RoomStore | HomeStore) {
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

/** A random id, from `getRandomValues`, which pages served over plain HTTP have too. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
