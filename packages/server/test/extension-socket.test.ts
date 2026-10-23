import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge, DirectoryDoc, defineNudgeExtension, type Nudge } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, serveNudge } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

const closedSessions: string[] = [];
const echo = defineNudgeExtension({
  name: "echo",
  version: "1.0.0",
  setup: () => ({
    roomSocket: ({ room, player }, socket) => ({
      receive: (data) => socket.send(`${room.id}/${player.id}: ${data}`),
      close: () => closedSessions.push(`${room.id}/${player.id}`),
    }),
  }),
});

type Client = {
  readonly frames: string[];
  readonly closed: Promise<{ code: number }>;
  send(text: string): void;
  close(): void;
};

function connect(url: string, token: string): Client {
  const socket = new WebSocket(url);
  const frames: string[] = [];
  const closed = new Promise<{ code: number }>((resolve) =>
    socket.addEventListener("close", (event) => resolve({ code: event.code })),
  );
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", token })));
  socket.addEventListener("message", (event) => frames.push(String(event.data)));
  return { frames, closed, send: (text) => socket.send(text), close: () => socket.close() };
}

async function eventually(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("extension room sockets", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let base: string;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [echo],
      },
      context,
    );
    tokens = {};
    for (const name of ["Ann", "Cy"])
      tokens[name] = (await nudge.players.invite(name, context)).token;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann"] }, context);
    server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
    base = `${server.url.replace(/^http/, "ws")}/v1/a/robin/rooms`;
  });

  afterEach(async () => {
    await server.close();
    await nudge.close(context);
  });

  it("lets a member in and passes frames both ways", async () => {
    const client = connect(`${base}/trip/ext/echo`, tokens.Ann!);
    await eventually(() => client.frames.includes(JSON.stringify({ type: "ready" })));
    client.send("hi");
    await eventually(() => client.frames.includes("trip/ann: hi"));
    client.close();
    await eventually(() => closedSessions.includes("trip/ann"));
  });

  it("refuses bad tokens, non-members and unknown extensions", async () => {
    expect((await connect(`${base}/trip/ext/echo`, "nudge_nope").closed).code).toBe(4401);
    expect((await connect(`${base}/trip/ext/echo`, tokens.Cy!).closed).code).toBe(4404);
    expect((await connect(`${base}/trip/ext/nothing`, tokens.Ann!).closed).code).toBe(4404);
    const elsewhere = base.replace("/a/robin/", "/a/nobody/");
    expect((await connect(`${elsewhere}/trip/ext/echo`, tokens.Ann!).closed).code).toBe(4404);
    const lobby = connect(`${base}/lobby/ext/echo`, tokens.Cy!);
    await eventually(() => lobby.frames.length > 0);
    lobby.close();
  });

  it("closes with 4401 when the token is revoked", async () => {
    const client = connect(`${base}/trip/ext/echo`, tokens.Ann!);
    await eventually(() => client.frames.includes(JSON.stringify({ type: "ready" })));
    const ann = (await nudge.players.tokens("ann", context))[0]!;
    await nudge.players.revoke(ann.clientId, context);
    expect((await client.closed).code).toBe(4401);
    await eventually(() => closedSessions.includes("trip/ann"));
  });

  it("closes with 4404 when the player leaves the room", async () => {
    await nudge.rooms.createShared({ id: "band", name: "Band", members: ["ann", "cy"] }, context);
    const ann = connect(`${base}/band/ext/echo`, tokens.Ann!);
    const cy = connect(`${base}/band/ext/echo`, tokens.Cy!);
    const ready = JSON.stringify({ type: "ready" });
    await eventually(() => ann.frames.includes(ready) && cy.frames.includes(ready));
    await nudge.harness.commit(async (tx) => {
      (await tx.doc(DirectoryDoc)).rooms.band!.members = ["ann"];
    }, context);
    expect((await cy.closed).code).toBe(4404);
    await eventually(() => closedSessions.includes("band/cy"));
    // Those still in it keep their socket.
    ann.send("still here");
    await eventually(() => ann.frames.includes("band/ann: still here"));
    ann.close();
  });

  it("lists a room's extensions and turns them off and on over HTTP", async () => {
    const call = async (method: string, path: string, token: string, body?: unknown) => {
      const response = await fetch(`${server.url}/v1/a/robin/rooms/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: (await response.json()) as any };
    };
    expect((await call("GET", "trip/extensions", tokens.Ann!)).json).toEqual({
      extensions: [{ name: "echo", version: "1.0.0", enabled: true, byDefault: true }],
    });
    expect((await call("GET", "trip/extensions", tokens.Cy!)).status).toBe(404);
    expect(
      (await call("PUT", "trip/extensions/echo", tokens.Ann!, { enabled: false })).json,
    ).toMatchObject({ enabled: false, byDefault: true });
    expect(
      (await call("PUT", "trip/extensions/nudge", tokens.Ann!, { enabled: false })).status,
    ).toBe(404);
    expect((await call("PUT", "trip/extensions/echo", tokens.Ann!, { on: 1 })).status).toBe(400);

    // Its socket is gone from the room while it is off.
    expect((await connect(`${base}/trip/ext/echo`, tokens.Ann!).closed).code).toBe(4404);
    await call("PUT", "trip/extensions/echo", tokens.Ann!, { enabled: null });
    const client = connect(`${base}/trip/ext/echo`, tokens.Ann!);
    await eventually(() => client.frames.length > 0);
    client.close();
  });
});
