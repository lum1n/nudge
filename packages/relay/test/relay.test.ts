import { generateKeyPairSync, randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge, type Nudge } from "@nudge/core";
import {
  type Apns,
  Fcm,
  newDeviceKey,
  openOnDevice,
  PushDoc,
  pushExtension,
} from "@nudge/ext-push";
import { createApp } from "@nudge/server";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Handles } from "../src/handles.ts";
import { Limits } from "../src/limits.ts";
import { relayApp } from "../src/relay.ts";

const context = BACKGROUND_CONTEXT;
const RELAY = "https://relay.example";

/** A stand-in for Google's token endpoint and FCM that keeps what it was sent. */
function fakeFcm() {
  const sent: { token: string; data: Record<string, string>; collapseKey: string }[] = [];
  const gone = new Set<string>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) === "https://oauth.example/token")
      return Response.json({ access_token: "access", expires_in: 3600 });
    const { message } = JSON.parse(String(init!.body)) as {
      message: { token: string; data: Record<string, string>; android: { collapse_key: string } };
    };
    sent.push({
      token: message.token,
      data: message.data,
      collapseKey: message.android.collapse_key,
    });
    if (gone.has(message.token))
      return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
    return Response.json({ name: "projects/nudge/messages/1" });
  };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fcm = new Fcm({
    serviceAccount: {
      project_id: "nudge",
      client_email: "relay@nudge.example",
      private_key: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
      token_uri: "https://oauth.example/token",
    },
    origin: "https://fcm.example",
    fetch,
  });
  return { fcm, sent, gone };
}

/** An APNs sender that keeps what it was asked to send. */
function fakeApns() {
  const sent: unknown[][] = [];
  const apns = {
    send: async (...args: unknown[]) => {
      sent.push(args);
      return "sent" as const;
    },
    close: () => {},
  } as unknown as Apns;
  return { apns, sent };
}

const post = (app: Hono, path: string, body: unknown, address = "1.2.3.4") =>
  app.request(`${RELAY}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-address": address },
    body: JSON.stringify(body),
  });

const byHeader = (c: { req: { header(name: string): string | undefined } }) =>
  c.req.header("x-test-address") ?? "";

describe("handles", () => {
  it("are opaque, and only the relay that made them can read them", () => {
    const handles = new Handles(randomBytes(32));
    const handle = handles.make({ platform: "fcm", token: "phone-token" });
    expect(handle).toMatch(/^h1\.[\w-]+$/);
    expect(Buffer.from(handle.slice(3), "base64url").toString("latin1")).not.toContain("phone");
    expect(handles.read(handle)).toEqual({ platform: "fcm", token: "phone-token" });
    expect(new Handles(randomBytes(32)).read(handle)).toBeUndefined();
    const tampered = `${handle.slice(0, -2)}${handle.endsWith("A") ? "B" : "A"}A`;
    expect(handles.read(tampered)).toBeUndefined();
  });
});

describe("limits", () => {
  it("allow a burst, then refill over a minute", () => {
    let now = 0;
    const limits = new Limits(60, 2, () => now);
    expect([limits.take("a"), limits.take("a"), limits.take("a")]).toEqual([true, true, false]);
    expect(limits.take("b")).toBe(true);
    now += 1000;
    expect([limits.take("a"), limits.take("a")]).toEqual([true, false]);
  });
});

describe("relay", () => {
  it("passes a sealed push to APNs as a mutable alert, and to FCM as data", async () => {
    const apns = fakeApns();
    const fcm = fakeFcm();
    const app = relayApp({
      handleKey: randomBytes(32),
      apns: apns.apns,
      fcm: fcm.fcm,
      address: byHeader,
    });
    const apple = (await (
      await post(app, "/v1/register", {
        platform: "apns",
        token: "ab".repeat(32),
        environment: "sandbox",
      })
    ).json()) as { handle: string };
    const android = (await (
      await post(app, "/v1/register", { platform: "fcm", token: "pixel" })
    ).json()) as {
      handle: string;
    };
    expect((await post(app, "/v1/register", { platform: "apns", token: "nope" })).status).toBe(400);

    expect(
      (await post(app, "/v1/send", { handle: apple.handle, sealed: "v1.x", collapseId: "c1" }))
        .status,
    ).toBe(204);
    expect(apns.sent[0]).toEqual([
      "ab".repeat(32),
      "sandbox",
      {
        title: "Nudge",
        body: "New message",
        collapseId: "c1",
        threadId: "c1",
        data: { sealed: "v1.x" },
        mutableContent: true,
      },
    ]);
    expect((await post(app, "/v1/send", { handle: android.handle, sealed: "v1.y" })).status).toBe(
      204,
    );
    expect(fcm.sent[0]).toEqual({ token: "pixel", data: { sealed: "v1.y" }, collapseKey: "nudge" });

    fcm.gone.add("pixel");
    expect((await post(app, "/v1/send", { handle: android.handle, sealed: "v1.y" })).status).toBe(
      410,
    );
    expect((await post(app, "/v1/send", { handle: "h1.made-up", sealed: "v1.y" })).status).toBe(
      410,
    );
  });

  it("refuses a platform it has no credentials for", async () => {
    const app = relayApp({ handleKey: randomBytes(32), fcm: fakeFcm().fcm, address: byHeader });
    const refused = await post(app, "/v1/register", { platform: "apns", token: "ab".repeat(32) });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/APNs/);
  });

  it("limits pushes per sender and per device", async () => {
    const fcm = fakeFcm();
    const app = relayApp({
      handleKey: randomBytes(32),
      fcm: fcm.fcm,
      address: byHeader,
      perAddressPerMinute: 3,
      perDevicePerMinute: 2,
      now: () => 0,
    });
    const handleOf = async (token: string) =>
      (
        (await (await post(app, "/v1/register", { platform: "fcm", token }, token)).json()) as {
          handle: string;
        }
      ).handle;
    const send = async (handle: string, address: string) =>
      (await post(app, "/v1/send", { handle, sealed: "v1.z" }, address)).status;
    // One device, from three senders.
    const pixel = await handleOf("pixel");
    expect([await send(pixel, "a"), await send(pixel, "b"), await send(pixel, "c")]).toEqual([
      204, 204, 429,
    ]);
    // One sender, to four devices.
    const statuses = [];
    for (const token of ["d1", "d2", "d3", "d4"])
      statuses.push(await send(await handleOf(token), "z"));
    expect(statuses).toEqual([204, 204, 204, 429]);
  });
});

describe("a host pushing through the relay", () => {
  let nudge: Nudge;
  let host: Hono;
  let relay: Hono;
  let fcm: ReturnType<typeof fakeFcm>;
  let faux: ReturnType<typeof fauxProvider>;
  let tokens: Record<string, string>;
  /** Everything the host sent the relay, as it went. */
  let wire: string[];

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await host.request(`https://host.example/v1/a/robin${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text === "" ? undefined : JSON.parse(text) };
  };

  const until = async (check: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 5_000;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("Timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  beforeEach(async () => {
    fcm = fakeFcm();
    wire = [];
    relay = relayApp({ handleKey: randomBytes(32), fcm: fcm.fcm, address: () => "host" });
    const toRelay: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== RELAY) throw new Error(`No server at ${url.origin}`);
      wire.push(String(init?.body));
      return relay.request(url.toString(), init);
    };
    faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    nudge = await createNudge(
      {
        name: "robin",
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        displayName: "Robin",
        extensions: [
          {
            extension: pushExtension({ fetch: toRelay }),
            settings: { preview: "text", relays: [`${RELAY}/`] },
          },
        ],
      },
      context,
    );
    tokens = {};
    for (const name of ["Ann", "Bo"])
      tokens[name] = (await nudge.players.invite(name, context)).token;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
    host = createApp({ assistants: new Map([["robin", nudge]]) });
  });

  afterEach(async () => {
    await nudge.close(context);
  });

  it("seals each push for the device, so the relay reads nothing", async () => {
    expect((await call("GET", "/ext/push/devices", tokens.Ann!)).json).toEqual({
      apns: false,
      fcm: false,
      relays: [RELAY],
    });
    const device = newDeviceKey();
    const other = newDeviceKey();
    const handleOf = async (token: string) =>
      (
        (await (await post(relay, "/v1/register", { platform: "fcm", token })).json()) as {
          handle: string;
        }
      ).handle;
    const register = async (token: string, deviceKey: string, relayUrl = RELAY) =>
      (
        await call("POST", "/ext/push/devices", tokens.Bo!, {
          platform: "relay",
          relay: relayUrl,
          handle: await handleOf(token),
          deviceKey,
        })
      ).status;
    expect(await register("bo-pixel", device.publicKey, "https://other.example")).toBe(400);
    expect(await register("bo-tablet", other.publicKey)).toBe(204);
    expect(await register("bo-pixel", device.publicKey)).toBe(204);
    // The same device again gets a fresh handle; its key says it is the same one.
    expect(await register("bo-pixel", device.publicKey)).toBe(204);
    const doc = await nudge.harness.snapshot(PushDoc, "bo", context);
    expect(doc?.devices?.map((d) => d.deviceKey)).toEqual([other.publicKey, device.publicKey]);

    faux.setResponses([fauxAssistantMessage("The train leaves at 09:12.")]);
    await call("POST", "/rooms/trip/messages", tokens.Ann!, { text: "Train?", requestId: "r1" });
    await until(() => fcm.sent.length === 2);
    const mine = fcm.sent.map((s) => openOnDevice(device.privateKey, s.data.sealed!)).find(Boolean);
    expect(mine).toEqual({
      assistant: "robin",
      roomId: "trip",
      kind: "answer",
      url: "/robin/trip",
      title: "Robin · Trip",
      body: "The train leaves at 09:12.",
      tag: "robin/trip",
    });
    for (const sent of wire) {
      expect(sent).not.toContain("09:12");
      expect(sent).not.toContain("trip");
    }
    expect(fcm.sent[0]!.collapseKey).not.toContain("trip");
  });

  it("forgets a device the relay calls gone", async () => {
    const device = newDeviceKey();
    const { handle } = (await (
      await post(relay, "/v1/register", { platform: "fcm", token: "bo-pixel" })
    ).json()) as {
      handle: string;
    };
    await call("POST", "/ext/push/devices", tokens.Bo!, {
      platform: "relay",
      relay: RELAY,
      handle,
      deviceKey: device.publicKey,
    });
    fcm.gone.add("bo-pixel");
    faux.setResponses([fauxAssistantMessage("Done.")]);
    await call("POST", "/rooms/trip/messages", tokens.Ann!, { text: "Hi", requestId: "r1" });
    await until(
      async () => (await nudge.harness.snapshot(PushDoc, "bo", context))?.devices?.length === 0,
    );
  });
});
