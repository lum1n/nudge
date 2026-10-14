import {
  CLOSE,
  type ClientFrame,
  PROTOCOL_VERSION,
  type ServerFrame,
  type Target,
} from "@nudge/protocol";
import type { Subscriber } from "./stores.ts";

export type Welcome = Extract<ServerFrame, { type: "welcome" }>;

/** The parts of a WebSocket the connection uses; the browser's, Node's and `ws`'s all fit. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close",
    listener: (event: SocketEvent) => void,
  ): void;
}

/** What the connection reads off socket events: `data` of a message, `code` and `reason` of a close. */
export type SocketEvent = {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
};

export type ConnectionStatus =
  /** Opening a socket, or waiting for the welcome. */
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "open"; readonly welcome: Welcome }
  /** Lost, and trying again at `retryAt` (ms since the epoch). */
  | {
      readonly kind: "waiting";
      readonly attempt: number;
      readonly retryAt: number;
      readonly code: number;
    }
  /**
   * Given up: `close()` was called (code 1000), the token is missing, unknown or revoked (4401),
   * the server didn't take a frame (4400), or there is no such assistant (4404).
   */
  | { readonly kind: "closed"; readonly code: number; readonly reason: string };

export type ConnectionOptions = {
  /** `ws(s)://…/v1/a/<assistant>/connect`; see `connectUrl`. */
  readonly url: string;
  /** Read on every attempt, so a new token is picked up on the next one. */
  readonly token: () => string | undefined;
  readonly client: { readonly name: string; readonly version: string; readonly platform: string };
  /** Default `new WebSocket(url)`. */
  readonly socket?: (url: string) => SocketLike;
  /** Delay before the first retry, doubled on each one after it, up to `maxMs`; with jitter. */
  readonly backoff?: { readonly startMs?: number; readonly maxMs?: number };
  /** How long to wait for any frame before a ping, until the welcome says otherwise. */
  readonly heartbeatMs?: number;
  /** `error` frames: the server couldn't use a frame, the socket stays open. */
  readonly onError?: (message: string) => void;
};

/** Close codes not worth retrying: the server will say the same again. */
const GIVE_UP: ReadonlySet<number> = new Set([
  CLOSE.badRequest,
  CLOSE.unauthorized,
  CLOSE.notFound,
]);
/** Our own code for a socket we dropped because it went quiet. */
const QUIET = 4000;

/** The socket address for `assistant` on `server` (`""` for the page's own origin). */
export function connectUrl(server: string, assistant: string): string {
  const base =
    server === "" ? (globalThis as { location?: { origin: string } }).location?.origin : server;
  if (base === undefined) throw new Error("A server address is needed outside a browser");
  const url = new URL(`${base.replace(/\/+$/, "")}/v1/a/${encodeURIComponent(assistant)}/connect`);
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  return url.toString();
}

/**
 * One socket to an assistant, kept open: it signs in, subscribes every watched target, hands each
 * target's frames to its subscriber, pings when the server goes quiet, and reconnects with backoff
 * when the socket drops, subscribing again (the server keeps no state between sockets). A target
 * whose frames stop following on (`Subscriber.receive` returns false) is subscribed again.
 */
export class Connection {
  private socket: SocketLike | undefined;
  private current: ConnectionStatus = { kind: "closed", code: 1000, reason: "Not opened" };
  private readonly watched = new Map<Target, Subscriber>();
  private readonly listeners = new Set<() => void>();
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private quiet: ReturnType<typeof setTimeout> | undefined;
  private heartbeatMs: number;

  constructor(private readonly options: ConnectionOptions) {
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getStatus = (): ConnectionStatus => this.current;

  /** Starts connecting, unless already connected or connecting. */
  open(): void {
    if (this.current.kind === "connecting" || this.current.kind === "open") return;
    clearTimeout(this.retry);
    this.attempt = 0;
    this.connect();
  }

  /** Reconnects at once when waiting to retry, such as when the network comes back. */
  retryNow(): void {
    if (this.current.kind !== "waiting") return;
    clearTimeout(this.retry);
    this.connect();
  }

  close(): void {
    clearTimeout(this.retry);
    this.drop();
    for (const subscriber of this.watched.values()) subscriber.resync();
    this.setStatus({ kind: "closed", code: 1000, reason: "Closed" });
  }

  /** Subscribes `target` now and after every reconnect, until the returned function is called. */
  watch(target: Target, subscriber: Subscriber): () => void {
    if (this.watched.has(target)) throw new Error(`${target} is watched already`);
    this.watched.set(target, subscriber);
    if (this.current.kind === "open") this.send({ type: "subscribe", target });
    return () => {
      if (this.watched.get(target) !== subscriber) return;
      this.watched.delete(target);
      if (this.current.kind === "open") this.send({ type: "unsubscribe", target });
    };
  }

  private connect(): void {
    const token = this.options.token();
    if (token === undefined) {
      this.setStatus({ kind: "closed", code: CLOSE.unauthorized, reason: "No token" });
      return;
    }
    this.setStatus({ kind: "connecting", attempt: this.attempt });
    const socket = (this.options.socket ?? ((url) => new WebSocket(url)))(this.options.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.listen();
      const { name, version, platform } = this.options.client;
      this.send({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        token,
        client: { name, version, platform },
      });
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.listen();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      this.receive(frame);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket === socket) this.lost(event.code ?? 1006, event.reason ?? "");
    });
  }

  private receive(frame: ServerFrame): void {
    switch (frame.type) {
      case "welcome":
        this.attempt = 0;
        this.heartbeatMs = frame.heartbeatMs;
        this.listen();
        this.setStatus({ kind: "open", welcome: frame });
        for (const [target, subscriber] of this.watched) {
          subscriber.resync();
          this.send({ type: "subscribe", target });
        }
        return;
      case "snapshot":
      case "patch":
      case "unsubscribed": {
        const subscriber = this.watched.get(frame.target);
        if (subscriber !== undefined && !subscriber.receive(frame))
          this.send({ type: "subscribe", target: frame.target });
        return;
      }
      case "error":
        this.options.onError?.(frame.message);
        return;
      case "pong":
        return;
    }
  }

  /**
   * Restarts the quiet timer: after `heartbeatMs` without a frame, ping; after as long again, give
   * the socket up as dead, since a lost network may not close it for minutes.
   */
  private listen(): void {
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => {
      this.send({ type: "ping" });
      this.quiet = setTimeout(() => {
        this.drop();
        this.lost(QUIET, "No answer to a ping");
      }, this.heartbeatMs);
    }, this.heartbeatMs);
  }

  private lost(code: number, reason: string): void {
    this.socket = undefined;
    clearTimeout(this.quiet);
    for (const subscriber of this.watched.values()) subscriber.resync();
    if (GIVE_UP.has(code)) {
      this.setStatus({ kind: "closed", code, reason });
      return;
    }
    const startMs = this.options.backoff?.startMs ?? 1000;
    const maxMs = this.options.backoff?.maxMs ?? 30_000;
    // Half fixed, half random, so clients cut off together don't come back together.
    const delay = Math.min(startMs * 2 ** this.attempt, maxMs) * (0.5 + Math.random() / 2);
    this.attempt += 1;
    this.setStatus({ kind: "waiting", attempt: this.attempt, retryAt: Date.now() + delay, code });
    this.retry = setTimeout(() => this.connect(), delay);
  }

  /** Closes the socket without hearing about it. */
  private drop(): void {
    clearTimeout(this.quiet);
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      // Closing a socket that never opened can throw; it is gone either way.
    }
  }

  private send(frame: ClientFrame): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      // Not open (yet, or any more): the close event, or the welcome, sorts it out.
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener();
  }
}
