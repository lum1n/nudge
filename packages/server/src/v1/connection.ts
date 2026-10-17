import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Credential } from "@nudge/core";
import {
  CLOSE,
  ClientFrame,
  diff,
  PROTOCOL_VERSION,
  type RoomView,
  type ServerFrame,
  type Target,
} from "@nudge/protocol";
import { toPlayer } from "@nudge/protocol/project";
import { Value } from "typebox/value";
import type { Hub, Hubs, Lease } from "./hub.ts";

const context = BACKGROUND_CONTEXT;

/** The socket as a connection needs it, whatever the runtime's WebSocket is. */
export type Socket = {
  send(text: string): void;
  close(code: number, reason: string): void;
};

export type ConnectionOptions = {
  readonly hubs: Hubs;
  /** Changes when the server restarts; clients that see a new one subscribe again. */
  readonly epoch: string;
  readonly version: string;
  /** Told to clients: ping when nothing arrived for this long. */
  readonly heartbeatMs: number;
  /** A subscription sends at most one patch per this many ms. */
  readonly flushMs: number;
  /** A socket that sends no `hello` in this time is closed. */
  readonly helloTimeoutMs: number;
  readonly report: (error: unknown) => void;
};

/**
 * One client socket of protocol v1: a `hello`, then subscriptions to the room list (`rooms`) and
 * to rooms. Each subscription keeps the view it last sent and sends the diff to the hub's view now,
 * at most every `flushMs`, so a busy room costs a slow client fewer, larger patches rather than a
 * backlog.
 */
export class Connection {
  private credential: Credential | undefined;
  private readonly subscriptions = new Map<Target, Subscription>();
  private closed = false;
  private stopWatchingToken: (() => void) | undefined;
  private readonly helloTimer: ReturnType<typeof setTimeout>;
  /** Frames are handled one at a time, in order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly socket: Socket,
    private readonly options: ConnectionOptions,
  ) {
    this.helloTimer = setTimeout(
      () => this.fail(CLOSE.badRequest, "Expected hello"),
      options.helloTimeoutMs,
    );
  }

  receive(data: string): void {
    this.queue = this.queue
      .then(() => this.handle(data))
      .catch((error: unknown) => {
        this.options.report(error);
        this.send({ type: "error", message: "Internal error" });
      });
  }

  /** The socket closed: let go of every hub. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    this.stopWatchingToken?.();
    for (const subscription of this.subscriptions.values()) subscription.stop();
    this.subscriptions.clear();
  }

  private async handle(data: string): Promise<void> {
    if (this.closed) return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      if (this.credential === undefined) return this.fail(CLOSE.badRequest, "Frames are JSON");
      return this.send({ type: "error", message: "Frames are JSON" });
    }
    if (this.credential === undefined) return this.hello(frame);
    if (!Value.Check(ClientFrame, frame))
      return this.send({ type: "error", message: "Not a protocol v1 frame" });
    switch (frame.type) {
      case "hello":
        return this.send({ type: "error", message: "Already said hello" });
      case "ping":
        return this.send({ type: "pong" });
      case "subscribe":
        return this.subscribe(frame.target, this.credential);
      case "unsubscribe":
        this.subscriptions.get(frame.target)?.stop();
        this.subscriptions.delete(frame.target);
        return;
    }
  }

  private async hello(frame: unknown): Promise<void> {
    if (!Value.Check(ClientFrame, frame) || frame.type !== "hello") {
      const protocol = (frame as { protocol?: unknown } | null)?.protocol;
      return this.fail(
        CLOSE.badRequest,
        protocol !== undefined && protocol !== PROTOCOL_VERSION
          ? `This server speaks protocol ${PROTOCOL_VERSION}`
          : "Expected hello",
      );
    }
    const credential = await this.options.hubs.nudge.players.authenticate(frame.token, context);
    if (this.closed) return;
    if (credential === undefined) return this.fail(CLOSE.unauthorized, "Unknown token");
    clearTimeout(this.helloTimer);
    this.credential = credential;
    const stop = await this.options.hubs.watchToken(credential.clientId, () =>
      this.fail(CLOSE.unauthorized, "Token revoked"),
    );
    if (this.closed) return stop();
    this.stopWatchingToken = stop;
    this.send({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      server: { version: this.options.version },
      epoch: this.options.epoch,
      player: toPlayer(credential.player),
      clientId: credential.clientId,
      heartbeatMs: this.options.heartbeatMs,
    });
  }

  private async subscribe(target: Target, { player }: Credential): Promise<void> {
    // Subscribing again starts over with a snapshot, which is how clients recover from a gap.
    this.subscriptions.get(target)?.stop();
    this.subscriptions.delete(target);

    let lease: Lease<Hub<unknown>> | undefined;
    let allowed: () => boolean = () => true;
    // A room list hub is the player's own already; a room hub's view is everyone's.
    let see: (view: unknown) => unknown = (view) => view;
    if (target === "rooms") {
      const roomList = await this.options.hubs.roomList(player.id);
      await roomList.hub.ready();
      lease = roomList;
    } else {
      const room = await this.options.hubs.room(target.slice("room:".length));
      if (room !== undefined && !room.hub.allows(player.id)) room.release();
      else if (room !== undefined) {
        const closed = this.options.hubs.opened(player.id, target.slice("room:".length));
        lease = {
          hub: room.hub,
          release: () => {
            closed();
            room.release();
          },
        };
        allowed = () => room.hub.allows(player.id);
        const viewer = this.options.hubs.viewer(player.id);
        see = (view) => viewer.room(view as RoomView);
      }
    }
    if (lease === undefined)
      return this.send({ type: "unsubscribed", target, reason: "not-found" });
    if (this.closed) return lease.release();

    const subscription = new Subscription(target, lease, this.options.flushMs, {
      send: (frame) => this.send(frame),
      allowed,
      see,
      ended: (reason) => {
        if (this.subscriptions.get(target) !== subscription) return;
        this.subscriptions.delete(target);
        if (reason === "closed") this.fail(CLOSE.goingAway, "The assistant shut down");
        else this.send({ type: "unsubscribed", target, reason });
      },
    });
    this.subscriptions.set(target, subscription);
    subscription.start();
  }

  private send(frame: ServerFrame): void {
    if (!this.closed) this.socket.send(JSON.stringify(frame));
  }

  private fail(code: number, reason: string): void {
    if (this.closed) return;
    this.socket.close(code, reason);
    this.close();
  }
}

type SubscriptionEvents = {
  readonly send: (frame: ServerFrame) => void;
  /** Whether the player may still see the target. */
  readonly allowed: () => boolean;
  /** The hub's view as the player may see it. */
  readonly see: (view: unknown) => unknown;
  readonly ended: (reason: "not-found" | "removed" | "closed") => void;
};

class Subscription {
  private seq = 0;
  private sent: unknown;
  private lastFlush = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unlisten: (() => void) | undefined;
  private stopped = false;

  constructor(
    private readonly target: Target,
    private readonly lease: Lease<Hub<unknown>>,
    private readonly flushMs: number,
    private readonly events: SubscriptionEvents,
  ) {}

  start(): void {
    this.sent = this.events.see(this.lease.hub.view());
    this.events.send({
      type: "snapshot",
      target: this.target,
      seq: this.seq,
      view: this.sent as Extract<ServerFrame, { type: "snapshot" }>["view"],
    });
    this.unlisten = this.lease.hub.listen({
      changed: () => this.schedule(),
      ended: (reason) => this.end(reason === "gone" ? "not-found" : "closed"),
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.unlisten?.();
    this.lease.release();
  }

  private schedule(): void {
    if (this.stopped || this.timer !== undefined) return;
    const wait = Math.max(0, this.lastFlush + this.flushMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.stopped) return;
    if (!this.events.allowed()) return this.end("removed");
    this.lastFlush = Date.now();
    const view = this.events.see(this.lease.hub.view());
    const ops = diff(this.sent, view);
    this.sent = view;
    if (ops.length > 0)
      this.events.send({ type: "patch", target: this.target, seq: ++this.seq, ops });
  }

  private end(reason: "not-found" | "removed" | "closed"): void {
    if (this.stopped) return;
    this.stop();
    this.events.ended(reason);
  }
}
