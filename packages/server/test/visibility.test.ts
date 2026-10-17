import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, type Nudge } from "@nudge/core";
import {
  apply,
  type RoomListView,
  ModelViewResponse,
  PrivateValuesResponse,
  type RoomView,
  ServerFrame,
  type Target,
  TimelineResponse,
} from "@nudge/protocol";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, serveNudge } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

const EMAIL = "ann@secret.example";

type Client = { view<V>(target: Target): V | undefined; close(): void };

function connect(url: string, token: string, targets: readonly Target[]): Client {
  const socket = new WebSocket(url);
  const views = new Map<Target, unknown>();
  socket.addEventListener("open", () =>
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: 1,
        token,
        client: { name: "test", version: "1", platform: "node" },
      }),
    ),
  );
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerFrame;
    expect(Value.Check(ServerFrame, frame)).toBe(true);
    if (frame.type === "welcome")
      for (const target of targets) socket.send(JSON.stringify({ type: "subscribe", target }));
    if (frame.type === "snapshot") views.set(frame.target, frame.view);
    if (frame.type === "patch") views.set(frame.target, apply(views.get(frame.target), frame.ops));
  });
  return {
    view: <V>(target: Target) => views.get(target) as V | undefined,
    close: () => socket.close(),
  };
}

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Every string in a value, joined, to look for a value anywhere in it. */
const textOf = (value: unknown) => JSON.stringify(value);

describe("per-person visibility", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let tokens: Record<string, string>;
  let clients: Client[];

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${server.url}/v1/a/robin${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: (text === "" ? undefined : JSON.parse(text)) as any };
  };
  const open = (name: string, targets: readonly Target[]) => {
    const client = connect(
      `${server.url.replace(/^http/, "ws")}/v1/a/robin/connect`,
      tokens[name]!,
      targets,
    );
    clients.push(client);
    return client;
  };
  const answered = (client: Client, count: number) => () =>
    (client.view<RoomView>("room:trip")?.timeline ?? []).filter(
      (item) => item.type === "answer" && item.status === "done",
    ).length >= count;

  beforeEach(async () => {
    const faux = fauxProvider({ tokensPerSecond: 500 });
    faux.setResponses([
      // Ann's private message: the model remembers, schedules and answers, all of it private.
      fauxAssistantMessage(
        [
          fauxText("Keeping that between us."),
          fauxToolCall("remember", { fact: "Ann writes from ⟦EMAIL1⟧" }),
          fauxToolCall("schedule_nudge", { message: "Mail ⟦EMAIL1⟧ back", in_minutes: 60 }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Noted, I'll write to ⟦EMAIL1⟧."),
      // Bo's public message: the answer names the value anyway.
      fauxAssistantMessage("Ann's address is ⟦EMAIL1⟧."),
    ]);
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
    for (const name of ["Ann", "Bo"])
      tokens[name] = (await nudge.players.invite(name, context)).token;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
    server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await server.close();
    await nudge.close(context);
  });

  it("shows a private message, its answer and what it made only to its author", async () => {
    const ann = open("Ann", ["room:trip", "rooms"]);
    const bo = open("Bo", ["room:trip", "rooms"]);
    await eventually(
      () => ann.view("room:trip") !== undefined && bo.view("room:trip") !== undefined,
    );

    const sent = await call("POST", "/rooms/trip/messages", tokens.Ann!, {
      text: `Write to me at ${EMAIL}, but keep it to yourself`,
      requestId: "r1",
      private: true,
    });
    expect(sent.status).toBe(202);
    await eventually(answered(ann, 1));
    await eventually(answered(bo, 1));
    await eventually(() => (ann.view<RoomView>("room:trip")?.nudges.length ?? 0) === 1);

    const annView = ann.view<RoomView>("room:trip")!;
    const [message, answer] = annView.timeline;
    expect(message).toMatchObject({
      type: "user",
      text: expect.stringContaining(EMAIL),
      privateTo: { id: "ann" },
    });
    expect(answer).toMatchObject({ type: "answer", privateTo: { id: "ann" } });
    expect(textOf(answer)).toContain(`I'll write to ${EMAIL}`);
    expect(annView.memory).toMatchObject([
      { text: `Ann writes from ${EMAIL}`, privateTo: { id: "ann" } },
    ]);
    expect(annView.nudges).toMatchObject([
      { message: `Mail ${EMAIL} back`, privateTo: { id: "ann" } },
    ]);

    // Bo sees that Ann wrote and was answered, and nothing of either.
    const boView = bo.view<RoomView>("room:trip")!;
    expect(boView.timeline[0]).toEqual({
      type: "user",
      id: message!.id,
      text: "",
      author: { id: "ann", displayName: "Ann" },
      sentAt: expect.any(Number),
      privateTo: { id: "ann", displayName: "Ann" },
    });
    expect(boView.timeline[1]).toEqual({
      type: "answer",
      id: answer!.id,
      status: "done",
      parts: [],
      privateTo: { id: "ann", displayName: "Ann" },
    });
    expect(boView.memory).toEqual([]);
    expect(boView.nudges).toEqual([]);
    expect(textOf(boView)).not.toContain(EMAIL);
    expect(textOf(bo.view<RoomListView>("rooms"))).not.toContain(EMAIL);
    expect(bo.view<RoomListView>("rooms")!.nudges).toEqual([]);

    // Bo can't cancel the private nudge, or forget the private fact.
    const nudgeId = annView.nudges[0]!.id;
    expect((await call("DELETE", `/nudges/${nudgeId}`, tokens.Bo!)).status).toBe(404);
    const factId = annView.memory[0]!.id;
    expect((await call("DELETE", `/rooms/trip/memory/${factId}`, tokens.Bo!)).status).toBe(404);

    // A public answer that names the value shows Bo its placeholder.
    await call("POST", "/rooms/trip/messages", tokens.Bo!, {
      text: "Where does Ann live?",
      requestId: "r2",
    });
    await eventually(answered(bo, 2));
    await eventually(answered(ann, 2));
    const boLast = bo.view<RoomView>("room:trip")!.timeline.at(-1)!;
    expect(textOf(boLast)).toContain("Ann's address is ⟦EMAIL1⟧.");
    expect(textOf(ann.view<RoomView>("room:trip")!.timeline.at(-1))).toContain(EMAIL);

    // History pages and the model view hold to the same.
    const page = await call(
      "GET",
      "/rooms/trip/timeline?limit=1&before=" +
        encodeURIComponent(
          Buffer.from(JSON.stringify({ before: 1_000_000 })).toString("base64url"),
        ),
      tokens.Bo!,
    );
    expect(Value.Check(TimelineResponse, page.json)).toBe(true);
    expect(textOf(page.json)).not.toContain(EMAIL);
    expect(textOf(page.json)).not.toContain("Keeping that between us");
    const modelView = await call("GET", "/rooms/trip/model-view", tokens.Bo!);
    expect(Value.Check(ModelViewResponse, modelView.json)).toBe(true);
    expect(textOf(modelView.json)).not.toContain("keep it to yourself");
    expect(textOf(modelView.json)).toContain("(Private to ⟦NAME1⟧.)");
    const annModel = await call("GET", "/rooms/trip/model-view", tokens.Ann!);
    expect(textOf(annModel.json)).toContain("keep it to yourself");
  });

  it("hides a value marked private from everyone but its owner, until it is forgotten", async () => {
    const protect = await call("POST", "/protect", tokens.Ann!, {
      value: "Storgata 5",
      private: true,
    });
    expect(protect).toEqual({ status: 200, json: { placeholder: "⟦PRIVATE1⟧" } });
    const values = await call("GET", "/me/private", tokens.Ann!);
    expect(Value.Check(PrivateValuesResponse, values.json)).toBe(true);
    expect(values.json).toEqual({
      values: [{ placeholder: "⟦PRIVATE1⟧", kind: "PRIVATE", value: "Storgata 5" }],
    });
    expect((await call("GET", "/me/private", tokens.Bo!)).json).toEqual({ values: [] });

    const ann = open("Ann", ["room:trip"]);
    const bo = open("Bo", ["room:trip"]);
    // Written out in a public message, the value still shows only to Ann.
    await call("POST", "/rooms/trip/messages", tokens.Ann!, {
      text: "Meet at Storgata 5",
      requestId: "r1",
    });
    const first = (client: Client) => client.view<RoomView>("room:trip")?.timeline[0];
    await eventually(() => first(ann) !== undefined && first(bo) !== undefined);
    expect(first(ann)).toMatchObject({ text: "Meet at Storgata 5" });
    expect(first(bo)).toMatchObject({ text: "Meet at ⟦PRIVATE1⟧" });

    expect(
      (await call("DELETE", `/vault/${encodeURIComponent("⟦PRIVATE1⟧")}`, tokens.Bo!)).status,
    ).toBe(403);
    expect(
      (await call("DELETE", `/vault/${encodeURIComponent("⟦PRIVATE1⟧")}`, tokens.Ann!)).status,
    ).toBe(204);
    expect(
      (await call("DELETE", `/vault/${encodeURIComponent("⟦PRIVATE1⟧")}`, tokens.Ann!)).status,
    ).toBe(404);
    expect((await call("GET", "/me/private", tokens.Ann!)).json).toEqual({ values: [] });
    // Forgotten, it is no one's any more: history holds only the placeholder, for everyone.
    expect(nudge.showTo("ann", "⟦PRIVATE1⟧")).toBe("⟦PRIVATE1⟧");
    await eventually(() => (first(ann) as { text?: string }).text === "Meet at ⟦PRIVATE1⟧");
    expect(first(bo)).toMatchObject({ text: "Meet at ⟦PRIVATE1⟧" });
    const conversation = await nudge.conversation("trip", context);
    const stored = JSON.stringify((await conversation.entries({}, 100, undefined, context)).items);
    expect(stored).not.toContain("Storgata 5");
  });
});
