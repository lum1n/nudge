import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Nudge } from "@nudge/core";
import { PROTOCOL_VERSION } from "@nudge/protocol";
import {
  env,
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { NudgeAssistant } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const BASE = "http://nudge.test/v1";

const call = (path: string, init?: RequestInit) => exports.default.fetch(`${BASE}${path}`, init);

const stub = () => env.NUDGE_ASSISTANT.getByName("robin");

/** The open assistant inside the Durable Object. */
const assistantOf = async (instance: NudgeAssistant): Promise<Nudge> =>
  (await (instance as unknown as { opening: Promise<{ nudge: Nudge }> }).opening).nudge;

async function claim(displayName = "Ann"): Promise<{ token: string; player: { id: string } }> {
  const response = await call("/a/robin/claim", {
    method: "POST",
    headers: { authorization: "Bearer claim-secret", "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

afterEach(() => reset());

describe("the Worker", () => {
  it("lists the configured assistants", async () => {
    const response = await call("/a");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      assistants: [{ name: "robin", displayName: "Robin" }],
    });
  });

  it("answers 404 for an assistant that isn't configured", async () => {
    const response = await call("/a/nobody/me");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'No assistant "nobody"' });
  });

  it("lets the claim secret make the first player once", async () => {
    const wrong = await call("/a/robin/claim", {
      method: "POST",
      headers: { authorization: "Bearer guess" },
      body: JSON.stringify({ displayName: "Mallory" }),
    });
    expect(wrong.status).toBe(401);

    const { token, player } = await claim();
    const me = await call("/a/robin/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ player: { id: player.id, displayName: "Ann" } });

    const again = await call("/a/robin/claim", {
      method: "POST",
      headers: { authorization: "Bearer claim-secret" },
      body: JSON.stringify({ displayName: "Bo" }),
    });
    expect(again.status).toBe(409);
  });

  it("keeps the assistant's data in the Durable Object when it is torn down", async () => {
    const { token } = await claim();
    const room = await call("/a/robin/rooms/personal", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(room.status).toBeLessThan(300);
    await room.body?.cancel();
    await abortAllDurableObjects();
    const me = await call("/a/robin/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
  });

  it("streams over a WebSocket", async () => {
    const { token, player } = await claim();
    const response = await call("/a/robin/connect", { headers: { upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const welcome = new Promise<unknown>((resolve) =>
      socket.addEventListener("message", (event: MessageEvent) =>
        resolve(JSON.parse(String(event.data))),
      ),
    );
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        token,
        client: { name: "test", version: "0", platform: "workerd" },
      }),
    );
    expect(await welcome).toMatchObject({ type: "welcome", player: { id: player.id } });
    socket.close();
  });
});

describe("nudges", () => {
  it("keep the alarm at the next one, and clear it when none is left", async () => {
    await claim();
    const soon = Date.now() + 60_000;
    const ids = await runInDurableObject(stub(), async (instance: NudgeAssistant) => {
      const nudge = await assistantOf(instance);
      const later = await nudge.nudges.schedule(
        "lobby",
        { message: "Later", fireAt: soon + 1_000 },
        context,
      );
      const first = await nudge.nudges.schedule(
        "lobby",
        { message: "Soon", fireAt: soon },
        context,
      );
      return [first.id, later.id] as const;
    });
    expect(await runInDurableObject(stub(), (_, state) => state.storage.getAlarm())).toBe(soon);

    await runInDurableObject(stub(), async (instance: NudgeAssistant) => {
      const nudge = await assistantOf(instance);
      await nudge.nudges.cancel(ids[0], context);
    });
    expect(await runInDurableObject(stub(), (_, state) => state.storage.getAlarm())).toBe(
      soon + 1_000,
    );

    await runInDurableObject(stub(), async (instance: NudgeAssistant) => {
      const nudge = await assistantOf(instance);
      await nudge.nudges.cancel(ids[1], context);
    });
    expect(await runInDurableObject(stub(), (_, state) => state.storage.getAlarm())).toBeNull();
  });

  it("fire from the alarm after the object was torn down", async () => {
    await claim();
    await runInDurableObject(stub(), async (instance: NudgeAssistant) => {
      const nudge = await assistantOf(instance);
      await nudge.nudges.schedule(
        "lobby",
        { message: "Put the kettle on", fireAt: Date.now() + 200, every: 3_600_000 },
        context,
      );
    });
    await abortAllDurableObjects();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await runDurableObjectAlarm(stub())).toBe(true);

    const { pending, entries } = await runInDurableObject(
      stub(),
      async (instance: NudgeAssistant) => {
        const nudge = await assistantOf(instance);
        const lobby = await nudge.rooms.get("lobby", context);
        const conversation = await nudge.harness.conversation(
          lobby!.conversationId as never,
          context,
        );
        const page = await conversation!.entries({ order: "ascending" }, 50, undefined, context);
        return {
          pending: await nudge.nudges.list(context),
          entries: page.items.map(({ kind }) => kind),
        };
      },
    );
    expect(entries).toContain("nudge.fire");
    // The repeat is next, an hour on, and the alarm is set for it.
    expect(pending).toHaveLength(1);
    expect(pending[0]!.fireAt).toBeGreaterThan(Date.now() + 3_000_000);
    expect(await runInDurableObject(stub(), (_, state) => state.storage.getAlarm())).toBe(
      pending[0]!.fireAt,
    );
  });
});
