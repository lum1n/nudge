import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ConfigError, createNudge, type Nudge, requestApproval } from "@nudge/core";
import {
  AdminPlayer,
  CLOSE,
  ExtensionSetupsResponse,
  MeResponse,
  NudgesResponse,
  PairingCodeResponse,
  PairResponse,
  PlayerMemoryResponse,
  PlayersResponse,
  Room,
  RoomsResponse,
  type RoomView,
  ServerFrame,
  type TimelineItem,
  TimelineResponse,
  TokensResponse,
  UsageResponse,
} from "@nudge/protocol";
import { RoomProjector, TIMELINE_LIMIT } from "@nudge/protocol/project";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExtensionSettings, type RunningServer, serveNudge } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

const client = { name: "test", version: "1", platform: "node" };

describe("v1 HTTP", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let tokens: Record<string, string>;

  /** A request to `/v1/a/robin<path>`; the reply's JSON, checked against `schema` when given. */
  const call = async (
    method: string,
    path: string,
    options: { token?: string; body?: unknown; schema?: TSchema } = {},
  ) => {
    const response = await fetch(`${server.url}/v1/a/robin${path}`, {
      method,
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const json = text === "" ? undefined : (JSON.parse(text) as unknown);
    if (options.schema !== undefined && response.ok)
      expect(Value.Check(options.schema, json)).toBe(true);
    return { status: response.status, json: json as any };
  };

  beforeEach(async () => {
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 80 }, (_, n) => fauxAssistantMessage(`Answer ${n}.`)));
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
      publicUrl: "https://nudge.example",
    });
  });

  afterEach(async () => {
    await server.close();
    await nudge.close(context);
  });

  it("lists assistants without a token and says who the caller is with one", async () => {
    const response = await fetch(`${server.url}/v1/a`);
    expect(await response.json()).toEqual({
      assistants: [{ name: "robin", displayName: expect.any(String) }],
    });
    expect(await call("GET", "/me")).toMatchObject({ status: 401 });
    expect(await call("GET", "/me", { token: "nudge_wrong" })).toMatchObject({ status: 401 });
    const me = await call("GET", "/me", { token: tokens.Ann, schema: MeResponse });
    expect(me.json).toMatchObject({ player: { id: "ann", displayName: "Ann" }, admin: true });
    expect((await call("GET", "/me", { token: tokens.Bo })).json.admin).toBe(false);
    expect((await fetch(`${server.url}/v1/a/nobody/me`)).status).toBe(404);
  });

  it("creates rooms with the caller as a member and checks bodies", async () => {
    const created = await call("POST", "/rooms", {
      token: tokens.Ann,
      body: { name: "Dinner", members: ["cy"] },
      schema: Room,
    });
    expect(created).toMatchObject({ status: 201 });
    expect(created.json).toEqual({
      id: "dinner",
      kind: "shared",
      name: "Dinner",
      members: [
        { id: "ann", displayName: "Ann" },
        { id: "cy", displayName: "Cy" },
      ],
    });
    expect(await call("POST", "/rooms", { token: tokens.Ann, body: { members: [] } })).toEqual({
      status: 400,
      json: { error: expect.stringContaining("name") },
    });
    expect(
      await call("POST", "/rooms", { token: tokens.Ann, body: { name: "X", members: ["zed"] } }),
    ).toMatchObject({ status: 400, json: { error: 'No player "zed"' } });
    const personal = await call("POST", "/rooms/personal", { token: tokens.Bo, schema: Room });
    expect(personal.json).toMatchObject({ id: "personal-bo", kind: "personal" });
  });

  it("sends messages once per request id, and hides rooms from non-members", async () => {
    const send = (token: string, requestId: string) =>
      call("POST", "/rooms/trip/messages", { token, body: { text: "Hi", requestId } });
    const first = await send(tokens.Ann!, "r1");
    expect(first.status).toBe(202);
    expect((await send(tokens.Ann!, "r1")).json).toEqual(first.json);
    expect((await send(tokens.Ann!, "r2")).json.submissionId).not.toBe(first.json.submissionId);
    expect(await send(tokens.Cy!, "r1")).toMatchObject({ status: 404 });
    expect(
      await call("POST", "/rooms/trip/messages", { token: tokens.Ann, body: { text: "Hi" } }),
    ).toMatchObject({ status: 400 });
    await nudge.harness.waitForIdle(context);
    expect(await call("POST", "/rooms/trip/abort", { token: tokens.Bo })).toEqual({
      status: 204,
      json: undefined,
    });
  });

  it("remembers, forgets, decides approvals and cancels nudges", async () => {
    const fact = await call("POST", "/rooms/trip/memory", {
      token: tokens.Ann,
      body: { text: "Ann likes tea" },
    });
    expect(fact).toMatchObject({ status: 201, json: { text: "Ann likes tea" } });
    expect(fact.json.by).toEqual({ id: "ann", displayName: "Ann" });
    expect(
      (await call("DELETE", `/rooms/trip/memory/${fact.json.id}`, { token: tokens.Bo })).status,
    ).toBe(204);
    expect((await call("DELETE", "/rooms/trip/memory/nope", { token: tokens.Bo })).status).toBe(
      404,
    );

    const approval = await nudge.harness.commit(
      (tx) =>
        requestApproval(
          tx,
          "trip",
          { extension: "test", kind: "pay", summary: "Pay 10 kr", payload: { amount: 10 } },
          Date.now(),
        ),
      context,
    );
    const decided = await call("POST", `/rooms/trip/approvals/${approval.id}`, {
      token: tokens.Bo,
      body: { approve: false },
    });
    expect(decided.json).toMatchObject({
      id: approval.id,
      status: "denied",
      decidedBy: { id: "bo", displayName: "Bo" },
    });
    expect(decided.json.payload).toBeUndefined();
    const again = await call("POST", `/rooms/trip/approvals/${approval.id}`, {
      token: tokens.Ann,
      body: { approve: true },
    });
    expect(again.status).toBe(409);

    const scheduled = await nudge.nudges.schedule(
      "trip",
      { message: "Kettle", fireAt: Date.now() + 60_000 },
      context,
    );
    expect((await call("DELETE", `/nudges/${scheduled.id}`, { token: tokens.Cy })).status).toBe(
      404,
    );
    expect((await call("DELETE", `/nudges/${scheduled.id}`, { token: tokens.Ann })).status).toBe(
      204,
    );
    expect(await nudge.nudges.list(context)).toEqual([]);

    const protectedValue = await call("POST", "/protect", {
      token: tokens.Ann,
      body: { value: "AB 12345", kind: "PLATE" },
    });
    expect(protectedValue.json.placeholder).toMatch(/PLATE/);
  });

  it("tells the month's spend, and admins every room's and player's", async () => {
    const ann = await call("GET", "/usage", { token: tokens.Ann, schema: UsageResponse });
    expect(ann.json).toMatchObject({ total: 0, mine: 0, budget: {}, months: [] });
    expect(ann.json.month).toMatch(/^\d{4}-\d{2}$/);
    const bo = await call("GET", "/usage", { token: tokens.Bo, schema: UsageResponse });
    expect(bo.json.months).toBeUndefined();
  });

  it("pairs a new client with a code from an admin, once", async () => {
    expect(
      await call("POST", "/admin/players", { token: tokens.Bo, body: { displayName: "Di" } }),
    ).toMatchObject({ status: 403 });
    const added = await call("POST", "/admin/players", {
      token: tokens.Ann,
      body: { displayName: "Di" },
    });
    expect(added).toMatchObject({ status: 201, json: { player: { id: "di", displayName: "Di" } } });
    expect(await nudge.players.tokens("di", context)).toEqual([]);

    const issued = await call("POST", "/admin/pairing-codes", {
      token: tokens.Ann,
      body: { playerId: "di" },
      schema: PairingCodeResponse,
    });
    const link = new URL(issued.json.link);
    expect(link.protocol).toBe("nudge:");
    expect(Object.fromEntries(link.searchParams)).toEqual({
      server: "https://nudge.example",
      assistant: "robin",
      code: issued.json.code,
    });
    expect(
      (await call("POST", "/admin/pairing-codes", { token: tokens.Ann, body: { playerId: "zed" } }))
        .status,
    ).toBe(404);

    const paired = await call("POST", "/pair", {
      body: { code: issued.json.code, client: { name: "Phone", platform: "ios" } },
      schema: PairResponse,
    });
    expect(paired.json.player).toEqual({ id: "di", displayName: "Di" });
    expect((await call("GET", "/me", { token: paired.json.token })).json.player.id).toBe("di");
    expect(
      await call("POST", "/pair", {
        body: { code: issued.json.code, client: { name: "Phone", platform: "ios" } },
      }),
    ).toMatchObject({ status: 401 });

    const listed = await call("GET", "/admin/tokens?player=di", {
      token: tokens.Ann,
      schema: TokensResponse,
    });
    expect(listed.json.tokens).toEqual([
      {
        clientId: paired.json.clientId,
        playerId: "di",
        createdAt: expect.any(Number),
        client: { name: "Phone", platform: "ios" },
      },
    ]);
    expect((await call("GET", "/admin/tokens", { token: tokens.Ann })).json.tokens).toHaveLength(4);
  });

  it("keeps a player's own memory, shared with their rooms only when they say so", async () => {
    const added = await call("POST", "/me/memory", {
      token: tokens.Ann,
      body: { text: "Vegetarian" },
    });
    expect(added).toMatchObject({
      status: 201,
      json: { id: "p1", text: "Vegetarian", by: { id: "ann", displayName: "Ann" } },
    });
    expect(
      (await call("GET", "/me/memory", { token: tokens.Ann, schema: PlayerMemoryResponse })).json,
    ).toMatchObject({ shared: false, facts: [{ id: "p1" }] });
    expect((await call("GET", "/me/memory", { token: tokens.Bo })).json).toEqual({
      facts: [],
      shared: false,
    });
    expect(await nudge.memory.visible("trip", context)).toEqual([]);

    const shared = await call("PUT", "/me/memory/sharing", {
      token: tokens.Ann,
      body: { shared: true },
      schema: PlayerMemoryResponse,
    });
    expect(shared.json.shared).toBe(true);
    expect(await nudge.memory.visible("trip", context)).toMatchObject([
      { id: "p1", owner: { playerId: "ann" } },
    ]);
    // Only the player forgets their own facts.
    expect((await call("DELETE", "/me/memory/p1", { token: tokens.Bo })).status).toBe(404);
    expect((await call("DELETE", "/rooms/trip/memory/p1", { token: tokens.Bo })).status).toBe(404);
    expect((await call("DELETE", "/me/memory/p1", { token: tokens.Ann })).status).toBe(204);
    expect(
      (await call("POST", "/me/memory", { token: tokens.Ann, body: { text: " " } })).status,
    ).toBe(400);
  });

  it("lets an admin manage players, tokens, rooms and nudges while serving", async () => {
    for (const [method, path] of [
      ["GET", "/admin/players"],
      ["GET", "/admin/rooms"],
      ["GET", "/admin/nudges"],
    ] as const)
      expect((await call(method, path, { token: tokens.Bo })).status).toBe(403);

    const players = await call("GET", "/admin/players", {
      token: tokens.Ann,
      schema: PlayersResponse,
    });
    expect(players.json.players).toEqual([
      { id: "ann", displayName: "Ann", admin: true },
      { id: "bo", displayName: "Bo", admin: false },
      { id: "cy", displayName: "Cy", admin: false },
    ]);

    const made = await call("PUT", "/admin/players/bo/admin", {
      token: tokens.Ann,
      body: { admin: true },
      schema: AdminPlayer,
    });
    expect(made.json).toEqual({ id: "bo", displayName: "Bo", admin: true });
    expect((await call("GET", "/admin/rooms", { token: tokens.Bo })).status).toBe(200);
    // The first player stays an admin.
    const kept = await call("PUT", "/admin/players/ann/admin", {
      token: tokens.Bo,
      body: { admin: false },
    });
    expect(kept.json.admin).toBe(true);
    expect(
      (await call("PUT", "/admin/players/zed/admin", { token: tokens.Ann, body: { admin: true } }))
        .status,
    ).toBe(404);

    const issued = await call("POST", "/admin/tokens", {
      token: tokens.Ann,
      body: { playerId: "cy" },
      schema: PairResponse,
    });
    expect(issued.status).toBe(201);
    expect((await call("GET", "/me", { token: issued.json.token })).json.player.id).toBe("cy");
    expect(
      (await call("POST", "/admin/tokens", { token: tokens.Ann, body: { playerId: "zed" } }))
        .status,
    ).toBe(404);

    // The caller isn't added to a room an admin makes for others.
    const created = await call("POST", "/admin/rooms", {
      token: tokens.Ann,
      body: { name: "Band", members: ["bo", "cy"] },
      schema: Room,
    });
    expect(created).toMatchObject({ status: 201, json: { id: "band", kind: "shared" } });
    expect(created.json.members.map((member: { id: string }) => member.id)).toEqual(["bo", "cy"]);
    expect(
      (await call("POST", "/admin/rooms", { token: tokens.Ann, body: { name: "X", members: [] } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/admin/rooms", {
          token: tokens.Ann,
          body: { name: "X", members: ["zed"] },
        })
      ).status,
    ).toBe(400);
    const rooms = await call("GET", "/admin/rooms", { token: tokens.Ann, schema: RoomsResponse });
    expect(rooms.json.rooms.map((room: { id: string }) => room.id)).toEqual([
      "lobby",
      "trip",
      "band",
    ]);

    await nudge.nudges.schedule(
      "band",
      { message: "Practice", fireAt: Date.now() + 3_600_000 },
      context,
    );
    await nudge.nudges.schedule("trip", { message: "Pack", fireAt: Date.now() + 60_000 }, context);
    const pending = await call("GET", "/admin/nudges", {
      token: tokens.Ann,
      schema: NudgesResponse,
    });
    expect(
      pending.json.nudges.map((n: { roomId: string; message: string }) => [n.roomId, n.message]),
    ).toEqual([
      ["trip", "Pack"],
      ["band", "Practice"],
    ]);
  });

  it("sets up extensions for admins only, through the server's settings", async () => {
    expect((await call("GET", "/admin/extensions", { token: tokens.Ann })).status).toBe(404);
    const saved: unknown[] = [];
    const settings: ExtensionSettings = {
      list: async () => [
        {
          from: "./extensions/lists",
          name: "lists",
          configured: true,
          enabled: true,
          settings: {},
          missingEnv: [],
        },
      ],
      save: async (_assistant, extensions) => {
        if (extensions.some((e) => e.from.startsWith("/"))) throw new ConfigError("Not allowed");
        saved.push(extensions);
        return settings.list("robin");
      },
    };
    await server.close();
    server = await serveNudge({
      assistants: new Map([["robin", nudge]]),
      port: 0,
      extensionSettings: settings,
    });
    expect((await call("GET", "/admin/extensions", { token: tokens.Bo })).status).toBe(403);
    const listed = await call("GET", "/admin/extensions", {
      token: tokens.Ann,
      schema: ExtensionSetupsResponse,
    });
    expect(listed.json.extensions[0].name).toBe("lists");
    const body = { extensions: [{ from: "./extensions/lists", enabled: false }] };
    expect(
      (
        await call("PUT", "/admin/extensions", {
          token: tokens.Ann,
          body,
          schema: ExtensionSetupsResponse,
        })
      ).status,
    ).toBe(200);
    expect(saved).toEqual([body.extensions]);
    const refused = await call("PUT", "/admin/extensions", {
      token: tokens.Ann,
      body: { extensions: [{ from: "/tmp/x.js", enabled: true }] },
    });
    expect(refused).toEqual({ status: 400, json: { error: "Not allowed" } });
    expect(
      (await call("PUT", "/admin/extensions", { token: tokens.Ann, body: { extensions: [{}] } }))
        .status,
    ).toBe(400);
  });

  it("closes the sockets of a revoked token with 4401", async () => {
    const bo = (await nudge.players.tokens("bo", context))[0]!;
    const socket = new WebSocket(`${server.url.replace("http", "ws")}/v1/a/robin/connect`);
    const frames: ServerFrame[] = [];
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "hello", protocol: 1, token: tokens.Bo, client })),
    );
    socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
    await eventually(() => frames.length > 0);

    expect(
      (await call("DELETE", `/admin/tokens/${bo.clientId}`, { token: tokens.Bo })).status,
    ).toBe(403);
    expect(
      (await call("DELETE", `/admin/tokens/${bo.clientId}`, { token: tokens.Ann })).status,
    ).toBe(204);
    expect(await closed).toBe(CLOSE.unauthorized);
    expect((await call("GET", "/me", { token: tokens.Bo })).status).toBe(401);
    expect(
      (await call("DELETE", `/admin/tokens/${bo.clientId}`, { token: tokens.Ann })).status,
    ).toBe(404);
  });

  it("signs a client out by revoking its own token", async () => {
    expect((await call("DELETE", "/me/token", { token: tokens.Bo })).status).toBe(204);
    expect((await call("GET", "/me", { token: tokens.Bo })).status).toBe(401);
    expect((await call("GET", "/me", { token: tokens.Ann })).status).toBe(200);
  });

  it("pages the history before the room view back to the start", async () => {
    // 60 messages and answers: more items than the room view holds.
    for (let n = 0; n < 60; n++)
      await nudge.submit("trip", { text: `Message ${n}`, requestId: `m${n}` }, context);
    await nudge.harness.waitForIdle(context);

    const watch = await nudge.watchRoom("trip", context);
    const room = { id: "trip", kind: "shared" as const, name: "Trip", members: [] };
    const view: RoomView = new RoomProjector().project({
      room,
      view: watch.value,
      approvals: [],
      memory: [],
      nudges: [],
    });
    const all = new RoomProjector(10_000).project({
      room,
      view: watch.value,
      approvals: [],
      memory: [],
      nudges: [],
    }).timeline;
    await watch.stop();
    expect(view.timeline).toHaveLength(TIMELINE_LIMIT);
    expect(view.hasEarlier).toBe(true);

    const pages: TimelineItem[][] = [];
    let before: string | undefined;
    do {
      const query = before === undefined ? "?limit=7" : `?limit=7&before=${before}`;
      const page = await call("GET", `/rooms/trip/timeline${query}`, {
        token: tokens.Bo,
        schema: TimelineResponse,
      });
      expect(page.status).toBe(200);
      pages.unshift(page.json.items);
      before = page.json.before;
    } while (before !== undefined);
    expect([...pages.flat(), ...view.timeline].map((item) => item.id)).toEqual(
      all.map((item) => item.id),
    );
    expect([...pages.flat(), ...view.timeline]).toEqual(all);

    expect((await call("GET", "/rooms/trip/timeline", { token: tokens.Cy })).status).toBe(404);
    expect(
      (await call("GET", "/rooms/trip/timeline?before=nope", { token: tokens.Ann })).status,
    ).toBe(400);
    // A room that fits in its view has no earlier items.
    expect((await call("GET", "/rooms/lobby/timeline", { token: tokens.Ann })).json).toEqual({
      items: [],
    });
  });
});

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
