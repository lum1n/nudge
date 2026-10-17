import type { ClientFrame, RoomView, ServerFrame } from "@nudge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Connection,
  type ConnectionOptions,
  connectUrl,
  RoomStore,
  type SocketEvent,
  type SocketLike,
} from "../src/index.ts";

/** A socket the test drives: it opens, receives and closes when told to. */
class FakeSocket implements SocketLike {
  readonly sent: ClientFrame[] = [];
  closed = false;
  private readonly handlers = new Map<string, ((event: SocketEvent) => void)[]>();

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.emit("open", {});
  }
  receive(frame: ServerFrame): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
  /** The server closed it, or the network did. */
  end(code: number): void {
    this.emit("close", { code, reason: "" });
  }
  private emit(type: string, event: SocketEvent): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

const welcome = (heartbeatMs = 25_000): ServerFrame => ({
  type: "welcome",
  protocol: 1,
  server: { version: "1" },
  epoch: "e",
  player: { id: "ann", displayName: "Ann" },
  clientId: "c1",
  heartbeatMs,
});

const view: RoomView = {
  room: { id: "trip", kind: "shared", name: "Trip", members: [] },
  timeline: [],
  hasEarlier: false,
  live: { running: false },
  queue: [],
  approvals: [],
  memory: [],
  nudges: [],
};

describe("Connection", () => {
  let sockets: FakeSocket[];
  let token: string | undefined;

  const connection = (options: Partial<ConnectionOptions> = {}) =>
    new Connection({
      url: "ws://nudge.test/v1/a/robin/connect",
      token: () => token,
      client: { name: "test", version: "1", platform: "node" },
      socket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      backoff: { startMs: 1000, maxMs: 8000 },
      ...options,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    sockets = [];
    token = "nudge_ann";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("says hello, subscribes what is watched, and subscribes again after a gap", () => {
    const conn = connection();
    const room = new RoomStore("trip");
    conn.watch("room:trip", room);
    conn.open();
    expect(conn.getStatus()).toEqual({ kind: "connecting", attempt: 0 });
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([
      {
        type: "hello",
        protocol: 1,
        token: "nudge_ann",
        client: { name: "test", version: "1", platform: "node" },
      },
    ]);
    sockets[0]!.receive(welcome());
    expect(conn.getStatus()).toMatchObject({ kind: "open", welcome: { clientId: "c1" } });
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "subscribe", target: "room:trip" });

    sockets[0]!.receive({ type: "snapshot", target: "room:trip", seq: 0, view });
    expect(room.getState().status).toBe("live");
    sockets[0]!.receive({ type: "patch", target: "room:trip", seq: 2, ops: [] });
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "subscribe", target: "room:trip" });
    expect(room.getState().status).toBe("syncing");

    const unwatchRoomList = conn.watch("rooms", new RoomStore("x"));
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "subscribe", target: "rooms" });
    unwatchRoomList();
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "unsubscribe", target: "rooms" });
  });

  it("reconnects with growing delays and subscribes again", () => {
    const conn = connection();
    const room = new RoomStore("trip");
    conn.watch("room:trip", room);
    conn.open();
    sockets[0]!.open();
    sockets[0]!.receive(welcome());
    sockets[0]!.receive({ type: "snapshot", target: "room:trip", seq: 0, view });

    sockets[0]!.end(1006);
    expect(conn.getStatus()).toMatchObject({ kind: "waiting", attempt: 1, code: 1006 });
    expect(room.getState()).toMatchObject({ status: "syncing", view });
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.end(1006);
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    // A server that is restarting: no welcome yet, so the delay keeps growing, up to the cap.
    for (let n = 0; n < 5; n++) {
      sockets.at(-1)!.end(1001);
      vi.advanceTimersByTime(8000);
    }
    expect(sockets).toHaveLength(8);

    sockets.at(-1)!.open();
    sockets.at(-1)!.receive(welcome());
    expect(sockets.at(-1)!.sent.at(-1)).toEqual({ type: "subscribe", target: "room:trip" });
    // The welcome reset the backoff.
    sockets.at(-1)!.end(1006);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(9);

    // `retryNow` skips the wait.
    sockets.at(-1)!.end(1006);
    conn.retryNow();
    expect(sockets).toHaveLength(10);
  });

  it("gives up on a bad token, a bad frame, an unknown assistant, or close()", () => {
    for (const code of [4401, 4400, 4404]) {
      const conn = connection();
      conn.open();
      sockets.at(-1)!.end(code);
      expect(conn.getStatus()).toMatchObject({ kind: "closed", code });
    }
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(3);

    const conn = connection();
    conn.open();
    sockets.at(-1)!.open();
    conn.close();
    expect(sockets.at(-1)!.closed).toBe(true);
    expect(conn.getStatus()).toMatchObject({ kind: "closed", code: 1000 });
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(4);

    token = undefined;
    const without = connection();
    without.open();
    expect(without.getStatus()).toMatchObject({ kind: "closed", code: 4401 });
    expect(sockets).toHaveLength(4);
  });

  it("pings a quiet server, and drops the socket when it stays quiet", () => {
    const conn = connection();
    conn.open();
    const socket = sockets[0]!;
    socket.open();
    socket.receive(welcome(1000));
    vi.advanceTimersByTime(999);
    expect(socket.sent.at(-1)?.type).toBe("hello");
    vi.advanceTimersByTime(1);
    expect(socket.sent.at(-1)).toEqual({ type: "ping" });
    socket.receive({ type: "pong" });
    vi.advanceTimersByTime(1500);
    expect(socket.closed).toBe(false);
    vi.advanceTimersByTime(500);
    expect(socket.closed).toBe(true);
    expect(conn.getStatus()).toMatchObject({ kind: "waiting", code: 4000 });
    // Its late close event changes nothing.
    socket.end(1006);
    expect(conn.getStatus()).toMatchObject({ kind: "waiting", attempt: 1 });
  });

  it("builds socket addresses from server addresses", () => {
    expect(connectUrl("https://nudge.example/", "robin")).toBe(
      "wss://nudge.example/v1/a/robin/connect",
    );
    expect(connectUrl("http://localhost:7777", "my bot")).toBe(
      "ws://localhost:7777/v1/a/my%20bot/connect",
    );
    expect(() => connectUrl("", "robin")).toThrow();
  });
});
