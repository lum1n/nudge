import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge, defineNudgeExtension, type Nudge } from "@nudge/core";
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
    base = `${server.url.replace(/^http/, "ws")}/a/robin/rooms`;
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
    const lobby = connect(`${base}/lobby/ext/echo`, tokens.Cy!);
    await eventually(() => lobby.frames.length > 0);
    lobby.close();
  });
});
