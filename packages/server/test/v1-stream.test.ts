import { writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, type Nudge, requestApproval } from "@nudge/core";
import {
  apply,
  CLOSE,
  type HomeView,
  type Op,
  type RoomView,
  ServerFrame,
  type Target,
} from "@nudge/protocol";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, serveNudge } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Everything Ann's socket received in the recorded run, one `{ frame, view }` per line: the frame,
 * and the view of its target after applying it. `NUDGE_RECORD=1` writes it again; the protocol's
 * and the clients' tests replay it.
 */
const FIXTURE = new URL("../../protocol/test/fixtures/room-stream.jsonl", import.meta.url);

type Client = {
  readonly frames: ServerFrame[];
  /** The view of each target after every frame for it, oldest first. */
  readonly views: Map<Target, unknown[]>;
  readonly welcome: Promise<Extract<ServerFrame, { type: "welcome" }>>;
  readonly closed: Promise<{ code: number; reason: string }>;
  view<V>(target: Target): V | undefined;
  send(frame: object): void;
  close(): void;
};

/** Frames that broke the protocol, from any client; every test ends with none. */
const problems: string[] = [];

function connect(url: string, hello: object | undefined): Client {
  const socket = new WebSocket(url);
  const frames: ServerFrame[] = [];
  const views = new Map<Target, unknown[]>();
  const seqs = new Map<Target, number>();
  let welcomed: (frame: Extract<ServerFrame, { type: "welcome" }>) => void;
  const welcome = new Promise<Extract<ServerFrame, { type: "welcome" }>>((r) => (welcomed = r));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    ),
  );
  socket.addEventListener("open", () => {
    if (hello !== undefined) socket.send(JSON.stringify(hello));
  });
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerFrame;
    if (!Value.Check(ServerFrame, frame)) problems.push(`Not a v1 frame: ${String(event.data)}`);
    frames.push(frame);
    if (frame.type === "welcome") welcomed(frame);
    if (frame.type === "snapshot") {
      seqs.set(frame.target, 0);
      views.set(frame.target, [frame.view]);
    }
    if (frame.type === "patch") {
      // Patches come one by one per target, without gaps.
      if (seqs.get(frame.target) !== frame.seq - 1)
        problems.push(`Gap in ${frame.target}: ${seqs.get(frame.target)} → ${frame.seq}`);
      seqs.set(frame.target, frame.seq);
      const list = views.get(frame.target)!;
      list.push(apply(list.at(-1), frame.ops));
    }
  });
  return {
    frames,
    views,
    welcome,
    closed,
    view: <V>(target: Target) => views.get(target)?.at(-1) as V | undefined,
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => socket.close(),
  };
}

const helloFor = (token: string) => ({
  type: "hello",
  protocol: 1,
  token,
  client: { name: "test", version: "1", platform: "node" },
});

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const opsOf = (client: Client, target: Target): Op[] =>
  client.frames.flatMap((frame) =>
    frame.type === "patch" && frame.target === target ? frame.ops : [],
  );

describe("v1 stream", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let connectUrl: string;
  let tokens: Record<string, string>;

  const open = (name: string) => connect(connectUrl, helloFor(tokens[name]!));
  const post = (path: string, token: string, body: object) =>
    fetch(`${server.url}/a/robin${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    const faux = fauxProvider({ tokensPerSecond: 200 });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking("Ann wants this kept."),
          fauxText("I'll note that."),
          fauxToolCall("remember", { fact: "Ann likes tea" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Noted: Ann likes tea, and I will remember it for a good long while."),
      fauxAssistantMessage("And Bo likes coffee."),
      fauxAssistantMessage("Time to put the kettle on!"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        settings: { progress: { partialIntervalMs: 20 } },
      },
      context,
    );
    tokens = {};
    for (const name of ["Ann", "Bo", "Cy"])
      tokens[name] = (await nudge.players.invite(name, context)).token;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
    server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
    connectUrl = `${server.url.replace("http", "ws")}/v1/a/robin/connect`;
  });

  afterEach(async () => {
    await server.close();
    await nudge.close(context);
    expect(problems.splice(0)).toEqual([]);
  });

  it("says who the client is, and closes for bad hellos", async () => {
    const ann = open("Ann");
    expect(await ann.welcome).toMatchObject({
      type: "welcome",
      protocol: 1,
      player: { id: "ann", displayName: "Ann" },
      heartbeatMs: 25_000,
    });
    ann.send({ type: "ping" });
    ann.send({ type: "dance" });
    ann.send({ type: "subscribe", target: "room:nowhere" });
    await eventually(() => ann.frames.length >= 4);
    expect(ann.frames.slice(1)).toEqual([
      { type: "pong" },
      { type: "error", message: "Not a protocol v1 frame" },
      { type: "unsubscribed", target: "room:nowhere", reason: "not-found" },
    ]);
    ann.close();

    const closeOf = async (url: string, hello: object | undefined) =>
      (await connect(url, hello).closed).code;
    expect(await closeOf(connectUrl, helloFor("nudge_wrong"))).toBe(CLOSE.unauthorized);
    expect(await closeOf(connectUrl, { type: "subscribe", target: "home" })).toBe(CLOSE.badRequest);
    expect(await closeOf(connectUrl, { ...helloFor(tokens.Ann!), protocol: 2 })).toBe(
      CLOSE.badRequest,
    );
    expect(await closeOf(connectUrl.replace("robin", "nobody"), helloFor(tokens.Ann!))).toBe(
      CLOSE.notFound,
    );
  });

  it("keeps rooms from players who may not use them", async () => {
    const cy = open("Cy");
    await cy.welcome;
    cy.send({ type: "subscribe", target: "room:trip" });
    cy.send({ type: "subscribe", target: "room:lobby" });
    cy.send({ type: "subscribe", target: "home" });
    await eventually(() => cy.frames.length >= 4);
    expect(cy.frames[1]).toEqual({
      type: "unsubscribed",
      target: "room:trip",
      reason: "not-found",
    });
    expect(cy.view<RoomView>("room:lobby")?.room).toMatchObject({ id: "lobby", kind: "lobby" });
    expect(cy.view<HomeView>("home")?.rooms.map((row) => row.room.id)).toEqual(["lobby"]);
    cy.close();
  });

  it("streams a room and home to every member, as patches that rebuild the view", async () => {
    const ann = open("Ann");
    const bo = open("Bo");
    await Promise.all([ann.welcome, bo.welcome]);
    for (const client of [ann, bo]) {
      client.send({ type: "subscribe", target: "room:trip" });
      client.send({ type: "subscribe", target: "home" });
    }
    await eventually(() => [ann, bo].every((client) => client.views.size === 2));
    expect(ann.view<RoomView>("room:trip")).toMatchObject({
      room: {
        id: "trip",
        kind: "shared",
        name: "Trip",
        members: [
          { id: "ann", displayName: "Ann" },
          { id: "bo", displayName: "Bo" },
        ],
      },
      timeline: [],
      hasEarlier: false,
      live: { running: false },
      queue: [],
      approvals: [],
      memory: [],
      nudges: [],
    });
    expect(ann.view<HomeView>("home")).toMatchObject({
      player: { id: "ann", displayName: "Ann" },
      rooms: [{ room: { id: "lobby" } }, { room: { id: "trip" }, running: false }],
    });

    expect(
      (
        await post("/rooms/trip/messages", tokens.Ann!, {
          text: "Remember I like tea",
          requestId: "r1",
        })
      ).status,
    ).toBe(202);
    await eventually(() => ann.view<RoomView>("room:trip")?.live.running === true);
    // Bo writes while the assistant is busy: the message waits in the queue.
    await post("/rooms/trip/messages", tokens.Bo!, { text: "I like coffee", requestId: "r1" });
    await nudge.harness.waitForIdle(context);
    await nudge.nudges.schedule("trip", { message: "Kettle", fireAt: Date.now() + 300 }, context);
    await eventually(() => (ann.view<HomeView>("home")?.nudges.length ?? 0) === 1);
    await eventually(() =>
      (ann.view<RoomView>("room:trip")?.timeline ?? []).some((item) => item.type === "nudge"),
    );
    await nudge.harness.waitForIdle(context);

    // A late subscriber's snapshot is what the patches built.
    const cy = open("Ann");
    await cy.welcome;
    cy.send({ type: "subscribe", target: "room:trip" });
    cy.send({ type: "subscribe", target: "home" });
    await eventually(() => cy.views.size === 2);
    const settled = cy.view<RoomView>("room:trip")!;
    await eventually(
      () =>
        JSON.stringify(ann.view("room:trip")) === JSON.stringify(settled) &&
        JSON.stringify(bo.view("room:trip")) === JSON.stringify(settled) &&
        JSON.stringify(ann.view("home")) === JSON.stringify(cy.view("home")),
    );
    cy.close();

    expect(settled.timeline.map((item) => item.type)).toEqual([
      "user",
      "answer",
      "user",
      "answer",
      "nudge",
      "answer",
    ]);
    expect(settled.timeline[0]).toMatchObject({
      type: "user",
      text: "Remember I like tea",
      author: { id: "ann", displayName: "Ann" },
      requestId: "r1",
    });
    expect(settled.timeline[1]).toMatchObject({
      type: "answer",
      status: "done",
      parts: [
        { type: "reasoning", text: "Ann wants this kept." },
        { type: "text", text: "I'll note that." },
        { type: "tool", name: "remember", status: "done" },
        { type: "text" },
      ],
    });
    // The remember tool's fact reached the panel without anyone asking for it.
    expect(settled.memory).toMatchObject([{ text: "Ann likes tea" }]);
    expect(settled.nudges).toEqual([]);
    expect(settled.live).toEqual({ running: false });

    const revisions = ann.views.get("room:trip") as RoomView[];
    expect(revisions.some((view) => view.queue.length > 0)).toBe(true);
    // Streaming arrives as appends, and the timeline is never sent whole again.
    const ops = opsOf(ann, "room:trip");
    expect(ops.some((op) => op.op === "append")).toBe(true);
    expect(ops.some((op) => op.op === "set" && op.path.length <= 1)).toBe(false);
    expect((ann.views.get("home") as HomeView[]).some((home) => home.rooms[1]?.running)).toBe(true);

    if (process.env.NUDGE_RECORD === "1") {
      const latest = new Map<Target, unknown>();
      const lines = ann.frames.map((frame) => {
        if (frame.type === "snapshot") latest.set(frame.target, frame.view);
        if (frame.type === "patch")
          latest.set(frame.target, apply(latest.get(frame.target), frame.ops));
        const view = "target" in frame ? latest.get(frame.target) : undefined;
        return JSON.stringify(view === undefined ? { frame } : { frame, view });
      });
      await writeFile(FIXTURE, `${lines.join("\n")}\n`);
    }

    for (const client of [ann, bo]) client.close();
  });

  it("sends memory and approval changes made outside a turn", async () => {
    const ann = open("Ann");
    await ann.welcome;
    ann.send({ type: "subscribe", target: "room:trip" });
    ann.send({ type: "subscribe", target: "home" });
    await eventually(() => ann.views.size === 2);

    await post("/rooms/trip/memory", tokens.Bo!, { text: "The car is blue" });
    await eventually(() => ann.view<RoomView>("room:trip")?.memory.length === 1);

    await nudge.harness.commit(
      (tx) =>
        requestApproval(
          tx,
          "trip",
          { extension: "mailer", kind: "send", summary: "Send the packing list", payload: null },
          0,
        ),
      context,
    );
    // A tool's request lands with its turn's entries; outside a turn, say it changed.
    nudge.changes.emit({ kind: "approvals", roomId: "trip" });
    await eventually(() => ann.view<RoomView>("room:trip")?.approvals[0]?.status === "pending");
    await eventually(() => ann.view<HomeView>("home")?.rooms[1]?.pendingApprovals === 1);
    expect(ann.view<RoomView>("room:trip")?.approvals[0]).toEqual({
      id: "a1",
      summary: "Send the packing list",
      status: "pending",
      requestedAt: 0,
    });

    await post("/rooms/trip/approvals/a1", tokens.Bo!, { approve: false });
    await eventually(() => ann.view<RoomView>("room:trip")?.approvals[0]?.status === "denied");
    expect(ann.view<RoomView>("room:trip")?.approvals[0]?.decidedBy).toEqual({
      id: "bo",
      displayName: "Bo",
    });
    await eventually(() => ann.view<HomeView>("home")?.rooms[1]?.pendingApprovals === 0);

    // A new room shows up at home.
    await post("/rooms", tokens.Bo!, { id: "dinner", name: "Dinner", members: ["ann"] });
    await eventually(() =>
      (ann.view<HomeView>("home")?.rooms ?? []).some((row) => row.room.id === "dinner"),
    );
    ann.close();
  });

  it("starts over on subscribe and stops on unsubscribe", async () => {
    const ann = open("Ann");
    await ann.welcome;
    ann.send({ type: "subscribe", target: "room:trip" });
    await eventually(() => ann.views.has("room:trip"));
    await post("/rooms/trip/memory", tokens.Ann!, { text: "One" });
    await eventually(() => ann.view<RoomView>("room:trip")?.memory.length === 1);

    ann.send({ type: "subscribe", target: "room:trip" });
    await eventually(() => ann.frames.filter((frame) => frame.type === "snapshot").length === 2);
    expect(ann.frames.at(-1)).toMatchObject({ type: "snapshot", seq: 0 });

    ann.send({ type: "unsubscribe", target: "room:trip" });
    ann.send({ type: "ping" });
    await eventually(() => ann.frames.at(-1)?.type === "pong");
    const count = ann.frames.length;
    await post("/rooms/trip/memory", tokens.Ann!, { text: "Two" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ann.frames).toHaveLength(count);
    ann.close();
  });

  it("closes with 1001 when the assistant shuts down", async () => {
    const ann = open("Ann");
    await ann.welcome;
    ann.send({ type: "subscribe", target: "room:trip" });
    await eventually(() => ann.views.has("room:trip"));
    await nudge.close(context);
    expect((await ann.closed).code).toBe(CLOSE.goingAway);
    // afterEach closes it again; a second close is harmless.
  });
});

describe("v1 stream pacing", () => {
  it("sends a busy room at most one patch per flush interval", async () => {
    const faux = fauxProvider({ tokensPerSecond: 400 });
    faux.setResponses([fauxAssistantMessage("word ".repeat(150))]);
    const models = createModels();
    models.setProvider(faux.provider);
    const nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        settings: { progress: { partialIntervalMs: 10 } },
      },
      context,
    );
    const { token } = await nudge.players.invite("Ann", context);
    const room = await nudge.rooms.ensurePersonal("ann", context);
    const server = await serveNudge({
      assistants: new Map([["robin", nudge]]),
      port: 0,
      timing: { flushMs: 150 },
    });
    try {
      const target: Target = `room:${room.id}`;
      const arrivals: number[] = [];
      const ann = connect(
        `${server.url.replace("http", "ws")}/v1/a/robin/connect`,
        helloFor(token),
      );
      await ann.welcome;
      ann.send({ type: "subscribe", target });
      await eventually(() => ann.views.has(target));
      const socketFrames = ann.frames.length;
      await fetch(`${server.url}/a/robin/rooms/${room.id}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "Talk", requestId: "1" }),
      });
      await nudge.harness.waitForIdle(context);
      await eventually(
        () =>
          ann.view<RoomView>(target)?.timeline.at(-1)?.type === "answer" &&
          ann.view<RoomView>(target)?.live.running === false,
      );
      for (const frame of ann.frames.slice(socketFrames))
        if (frame.type === "patch") arrivals.push(frame.seq);
      expect(arrivals.length).toBeGreaterThan(1);
      // About 0.4 s of streaming at one patch per 150 ms: a handful, not one per token.
      expect(arrivals.length).toBeLessThan(12);
      expect(problems.splice(0)).toEqual([]);
      ann.close();
    } finally {
      await server.close();
      await nudge.close(context);
    }
  });
});
