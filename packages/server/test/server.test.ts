import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import { createNudge, MESSAGE_ENTRY, type Nudge } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type MeResponse,
  type MessageResponse,
  type RoomResponse,
  type RunningServer,
  type ServerFrame,
  serveNudge,
  type TranscriptResponse,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

type Client = {
  readonly frames: ServerFrame[];
  readonly events: AgentEvent[];
  readonly snapshot: Promise<SnapshotEvent>;
  readonly closed: Promise<{ code: number; reason: string }>;
  send(frame: object): void;
  close(): void;
};

function connect(url: string, token: string): Client {
  const socket = new WebSocket(url);
  const frames: ServerFrame[] = [];
  const events: AgentEvent[] = [];
  let gotSnapshot: (snapshot: SnapshotEvent) => void;
  const snapshot = new Promise<SnapshotEvent>((resolve) => (gotSnapshot = resolve));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    ),
  );
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", token })));
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerFrame;
    frames.push(frame);
    if (frame.type === "snapshot") gotSnapshot(frame);
    if (frame.type === "events") events.push(...frame.events);
  });
  return {
    frames,
    events,
    snapshot,
    closed,
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => socket.close(),
  };
}

async function eventually(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const answers = (events: readonly AgentEvent[]) =>
  events.filter((event) => event.type === "message_end" && event.entry.kind === "pi.assistant");

describe("server", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let base: string;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 4 }, (_, n) => fauxAssistantMessage(`Answer ${n}.`)));
    const models = createModels();
    models.setProvider(faux.provider);
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
      },
      context,
    );
    tokens = {};
    for (const name of ["Ann", "Bo", "Cy"])
      tokens[name] = (await nudge.players.invite(name, context)).token;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
    server = await serveNudge({
      assistants: new Map([["robin", nudge]]),
      port: 0,
    });
    base = `${server.url}/a/robin`;
  });

  afterEach(async () => {
    await server.close();
    await nudge.close(context);
  });

  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });

  it("rejects missing and unknown tokens, and hides rooms from non-members", async () => {
    expect((await get("/me")).status).toBe(401);
    expect((await get("/me", "nudge_nope")).status).toBe(401);
    expect((await fetch(`${server.url}/a/nobody/me`)).status).toBe(404);

    const me = (await (await get("/me", tokens.Ann)).json()) as MeResponse;
    expect(me.player).toMatchObject({ id: "ann", displayName: "Ann" });
    expect(me.rooms.map((room) => room.id)).toEqual(["lobby", "trip"]);

    const trip = (await (await get("/rooms/trip", tokens.Bo)).json()) as RoomResponse;
    expect(trip.members.map((p) => p.displayName)).toEqual(["Ann", "Bo"]);
    expect((await get("/rooms/trip", tokens.Cy)).status).toBe(404);
    expect((await get("/rooms/trip/transcript", tokens.Cy)).status).toBe(404);
    expect((await get("/rooms/lobby/transcript", tokens.Cy)).status).toBe(200);

    const bad = connect(`${base.replace("http", "ws")}/rooms/trip/stream`, "nudge_nope");
    expect((await bad.closed).code).toBe(4401);
    const outsider = connect(`${base.replace("http", "ws")}/rooms/trip/stream`, tokens.Cy!);
    expect((await outsider.closed).code).toBe(4404);
  });

  it("lets two players talk in one room, with every client seeing the same events", async () => {
    const stream = `${base.replace("http", "ws")}/rooms/trip/stream`;
    const ann = connect(stream, tokens.Ann!);
    const bo = connect(stream, tokens.Bo!);
    await Promise.all([ann.snapshot, bo.snapshot]);

    ann.send({ type: "submit", text: "Where to?", requestId: "1" });
    bo.send({ type: "submit", text: "Somewhere warm!", requestId: "1" });
    await eventually(() =>
      [ann, bo].every((c) => c.frames.filter((f) => f.type === "submitted").length === 1),
    );
    await nudge.harness.waitForIdle(context);
    await eventually(() => answers(ann.events).length >= 1 && answers(bo.events).length >= 1);
    await eventually(() => JSON.stringify(ann.events) === JSON.stringify(bo.events));

    const authors = ann.events
      .filter((event) => event.type === "message_end" || event.type === "entry_appended")
      .map((event) => event.entry)
      .filter((entry) => entry.kind === MESSAGE_ENTRY)
      .map((entry) => (entry.data as { playerId: string }).playerId);
    expect(authors.sort()).toEqual(["ann", "bo"]);

    // A late joiner starts from a snapshot that already holds the conversation.
    const late = connect(stream, tokens.Bo!);
    const snapshot = await late.snapshot;
    const kinds = snapshot.entries.map((entry) => entry.kind);
    expect(kinds.filter((kind) => kind === MESSAGE_ENTRY)).toHaveLength(2);
    expect(kinds).toContain("pi.assistant");

    // The same over plain HTTP.
    const transcript = (await (
      await get("/rooms/trip/transcript?limit=100", tokens.Bo)
    ).json()) as TranscriptResponse;
    expect(transcript.entries.length).toBe(snapshot.entries.length);

    for (const client of [ann, bo, late]) client.close();
  });

  it("takes messages over HTTP, deduplicated per client by request id", async () => {
    const post = (body: object) =>
      fetch(`${base}/rooms/lobby/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.Cy}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = await post({ text: "hello", requestId: "x" });
    expect(first.status).toBe(202);
    const again = await post({ text: "hello", requestId: "x" });
    const id = async (response: Response) =>
      ((await response.json()) as MessageResponse).submissionId;
    expect(await id(again)).toBe(await id(first));
    expect((await post({ text: "" })).status).toBe(400);
    expect((await post({ text: "hi", whenBusy: "now" })).status).toBe(400);
    await nudge.harness.waitForIdle(context);

    const created = await fetch(`${base}/rooms`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.Cy}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Book club", members: ["ann"] }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: "book-club", members: ["cy", "ann"] });
  });
});
