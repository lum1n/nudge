import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge, type Nudge } from "@nudge/core";
import { RoomView, ServerFrame } from "@nudge/protocol";
import { RoomProjector } from "@nudge/protocol/project";
import { type RunningServer, serveNudge } from "@nudge/server";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Api,
  ApiError,
  listAssistants,
  memoryTokens,
  NudgeClient,
  type NudgeClientOptions,
  type SocketLike,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("NudgeClient against a server", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let annToken: string;
  const clients: NudgeClient[] = [];
  /** Every frame any client received that isn't protocol v1. */
  const problems: string[] = [];

  /** A client whose sockets the test can reach, and which checks every frame it gets. */
  const clientFor = (
    token: string | undefined,
    options: Partial<NudgeClientOptions> = {},
  ): { client: NudgeClient; sockets: WebSocket[] } => {
    const sockets: WebSocket[] = [];
    const client = new NudgeClient({
      server: server.url,
      assistant: "robin",
      tokens: memoryTokens(token),
      client: { name: "test", version: "1", platform: "node" },
      backoff: { startMs: 10, maxMs: 50 },
      socket: (url) => {
        const socket = new WebSocket(url);
        socket.addEventListener("message", (event) => {
          if (!Value.Check(ServerFrame, JSON.parse(String(event.data))))
            problems.push(String(event.data));
        });
        sockets.push(socket);
        return socket as SocketLike;
      },
      ...options,
    });
    clients.push(client);
    return { client, sockets };
  };

  beforeEach(async () => {
    const faux = fauxProvider({ tokensPerSecond: 200 });
    faux.setResponses([
      fauxAssistantMessage(`Hello Bo! ${"This answer arrives in several pieces. ".repeat(8)}`),
      ...Array.from({ length: 80 }, (_, n) => fauxAssistantMessage(`Answer ${n}.`)),
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
    annToken = (await nudge.players.invite("Ann", context)).token;
    await nudge.players.invite("Bo", context);
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
    server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.close();
    await nudge.close(context);
    expect(problems.splice(0)).toEqual([]);
  });

  it("pairs, follows the room list and a room, and swaps a pending message for the real one", async () => {
    expect(await listAssistants(server.url)).toEqual({
      assistants: [{ name: "robin", displayName: expect.any(String) }],
    });
    const admin = new Api({
      server: server.url,
      assistant: "robin",
      tokens: memoryTokens(annToken),
    });
    const { code } = await admin.pairingCode("bo");

    const { client } = clientFor(undefined);
    await expect(client.api.me()).rejects.toMatchObject({ status: 401 });
    const paired = await client.api.pair(code, { name: "test", platform: "node" });
    expect(paired.player).toEqual({ id: "bo", displayName: "Bo" });
    await expect(client.api.pair(code, { name: "test", platform: "node" })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(await client.api.me()).toMatchObject({ clientId: paired.clientId, admin: false });

    const roomList = client.roomList();
    const room = client.room("trip");
    // A second lease shares the store and the subscription.
    const again = client.room("trip");
    expect(again.store).toBe(room.store);
    again.release();
    client.open();
    await eventually(
      () => roomList.store.getState().status === "live" && room.store.getState().status === "live",
    );
    expect(client.connection.getStatus()).toMatchObject({
      kind: "open",
      welcome: { player: { id: "bo" }, clientId: paired.clientId },
    });
    expect(roomList.store.getState().view?.rooms.map((row) => row.room.id)).toEqual([
      "lobby",
      "trip",
    ]);

    // Streaming text arrives as appends: the answer's text grows through several states.
    const texts = new Set<string>();
    room.store.subscribe(() => {
      for (const item of room.store.getState().timeline)
        if (item.type === "answer")
          for (const part of item.parts) if (part.type === "text") texts.add(part.text);
    });
    const sending = client.send("trip", "Hello");
    expect(room.store.getState().pending).toMatchObject([{ text: "Hello" }]);
    const { submissionId } = await sending;
    expect(submissionId).toEqual(expect.any(Number));
    await eventually(() => {
      const last = room.store.getState().timeline.at(-1);
      return last?.type === "answer" && last.status === "done";
    });
    const state = room.store.getState();
    expect(state.pending).toEqual([]);
    expect(state.timeline[0]).toMatchObject({
      type: "user",
      text: "Hello",
      author: { id: "bo" },
      clientId: paired.clientId,
    });
    expect(texts.size).toBeGreaterThan(1);
    expect(Value.Check(RoomView, state.view)).toBe(true);

    // A failed send keeps the message, with the error, until it is sent again or dropped.
    const nowhere = client.room("nowhere");
    await eventually(() => nowhere.store.getState().status === "gone");
    expect(nowhere.store.getState().reason).toBe("not-found");
    await expect(client.send("nowhere", "Lost")).rejects.toMatchObject({ status: 404 });
    const [lost] = nowhere.store.getState().pending;
    expect(lost).toMatchObject({ text: "Lost", error: 'No room "nowhere"' });
    await expect(client.resend("nowhere", lost!.requestId)).rejects.toBeInstanceOf(ApiError);
    nowhere.store.dismiss(lost!.requestId);
    expect(nowhere.store.getState().pending).toEqual([]);
    nowhere.release();

    await client.api.remember("trip", "Bo likes coffee");
    await eventually(() => room.store.getState().view?.memory.length === 1);

    room.release();
    roomList.release();
  });

  it("loads earlier items back to the start, joining the room view", async () => {
    for (let n = 0; n < 60; n++)
      await nudge.submit("trip", { text: `Message ${n}`, requestId: `m${n}` }, context);
    await nudge.harness.waitForIdle(context);
    const watch = await nudge.watchRoom("trip", context);
    const all = new RoomProjector(10_000).project({
      room: { id: "trip", kind: "shared", name: "Trip", members: [] },
      view: watch.value,
      approvals: [],
      memory: [],
      nudges: [],
    }).timeline;
    await watch.stop();

    const { client } = clientFor(annToken);
    const room = client.room("trip");
    client.open();
    await eventually(() => room.store.getState().status === "live");
    expect(room.store.getState().canLoadEarlier).toBe(true);
    let pages = 0;
    while (room.store.getState().canLoadEarlier) {
      await room.store.loadEarlier(7);
      expect(room.store.getState().earlierError).toBeUndefined();
      pages += 1;
    }
    expect(pages).toBeGreaterThan(2);
    expect(room.store.getState().timeline).toEqual(all);
  });

  it("reconnects and subscribes again, and stops when its token is revoked", async () => {
    const admin = new Api({
      server: server.url,
      assistant: "robin",
      tokens: memoryTokens(annToken),
    });
    const { code } = await admin.pairingCode("bo");
    const tokens = memoryTokens();
    const { client, sockets } = clientFor(undefined, { tokens });
    const { clientId } = await client.api.pair(code, { name: "test", platform: "node" });
    const room = client.room("trip");
    client.open();
    await eventually(() => room.store.getState().status === "live");

    const statuses: string[] = [];
    room.store.subscribe(() => statuses.push(room.store.getState().status));
    sockets[0]!.close();
    await eventually(() => statuses.at(-1) === "live");
    expect(statuses).toEqual(["syncing", "live"]);
    expect(sockets).toHaveLength(2);

    await admin.revoke(clientId);
    await eventually(() => client.connection.getStatus().kind === "closed");
    expect(client.connection.getStatus()).toMatchObject({ code: 4401 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sockets).toHaveLength(2);

    const { client: lost } = clientFor(annToken, { assistant: "nobody" });
    lost.open();
    await eventually(() => lost.connection.getStatus().kind === "closed");
    expect(lost.connection.getStatus()).toMatchObject({ code: 4404 });
  });
});
