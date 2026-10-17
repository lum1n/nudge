import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge, type Nudge } from "@nudge/core";
import { type RunningServer, serveNudge } from "@nudge/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Apns, Fcm, PushDoc, pushExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

const apnsKey = () =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;

const serviceAccount = () => ({
  project_id: "nudge-test",
  client_email: "push@nudge-test.iam.example",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string,
  token_uri: "https://oauth.example/token",
});

/** A stand-in for APNs over cleartext HTTP/2; tokens in `gone` answer 410. */
async function fakeApns() {
  const received: { headers: IncomingHttpHeaders; body: unknown }[] = [];
  const gone = new Set<string>();
  const server: Http2Server = createServer();
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      received.push({ headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      const token = String(headers[":path"]).split("/").at(-1)!;
      if (gone.has(token)) {
        stream.respond({ ":status": 410, "content-type": "application/json" });
        stream.end(JSON.stringify({ reason: "Unregistered" }));
      } else {
        stream.respond({ ":status": 200 });
        stream.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    received,
    gone,
    origins: { production: origin, sandbox: origin },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A stand-in for Google's token endpoint and FCM; tokens in `gone` answer UNREGISTERED. */
function fakeFcm() {
  const sent: { token: string; message: Record<string, unknown> }[] = [];
  const exchanges: URLSearchParams[] = [];
  const gone = new Set<string>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://oauth.example/token") {
      exchanges.push(new URLSearchParams(String(init!.body)));
      return Response.json({ access_token: `access-${exchanges.length}`, expires_in: 3600 });
    }
    const headers = new Headers(init!.headers);
    expect(url).toBe("https://fcm.example/v1/projects/nudge-test/messages:send");
    expect(headers.get("authorization")).toMatch(/^Bearer access-\d$/);
    const { message } = JSON.parse(String(init!.body)) as {
      message: { token: string } & Record<string, unknown>;
    };
    sent.push({ token: message.token, message });
    if (gone.has(message.token))
      return Response.json(
        {
          error: {
            status: "NOT_FOUND",
            details: [{ "@type": "fcm.FcmError", errorCode: "UNREGISTERED" }],
          },
        },
        { status: 404 },
      );
    return Response.json({ name: "projects/nudge-test/messages/1" });
  };
  return { sent, exchanges, gone, fetch };
}

const until = async (check: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("APNs", () => {
  let apns: Awaited<ReturnType<typeof fakeApns>>;
  beforeEach(async () => {
    apns = await fakeApns();
  });
  afterEach(() => apns.close());

  it("sends an alert with a signed provider token, and reports gone devices", async () => {
    const key = apnsKey();
    const sender = new Apns({
      key,
      keyId: "KEY123",
      teamId: "TEAM456",
      bundleId: "app.nudge.dev",
      origins: apns.origins,
    });
    const notification = {
      title: "Robin · Trip",
      body: "New message",
      collapseId: "robin/trip",
      threadId: "robin/trip",
      data: { assistant: "robin", roomId: "trip" },
    };
    expect(await sender.send("ab".repeat(32), "sandbox", notification)).toBe("sent");
    apns.gone.add("cd".repeat(32));
    expect(await sender.send("cd".repeat(32), "production", notification)).toBe("gone");
    expect(await sender.send("not hex", "production", notification)).toBe("gone");
    sender.close();

    expect(apns.received).toHaveLength(2);
    const { headers, body } = apns.received[0]!;
    expect(headers[":path"]).toBe(`/3/device/${"ab".repeat(32)}`);
    expect(headers["apns-topic"]).toBe("app.nudge.dev");
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-collapse-id"]).toBe("robin/trip");
    expect(body).toEqual({
      aps: {
        alert: { title: "Robin · Trip", body: "New message" },
        sound: "default",
        "thread-id": "robin/trip",
      },
      assistant: "robin",
      roomId: "trip",
    });
    const [head, claims, signature] = String(headers.authorization)
      .slice("bearer ".length)
      .split(".");
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY123",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({
      iss: "TEAM456",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${claims}`),
        { key: createPublicKey(key), dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    // The same provider token for both: Apple refuses one renewed too often.
    expect(apns.received[1]!.headers.authorization).toBe(headers.authorization);
  });
});

describe("FCM", () => {
  it("trades the service account for an access token, kept between sends", async () => {
    const account = serviceAccount();
    const fcm = fakeFcm();
    const sender = new Fcm({
      serviceAccount: account,
      origin: "https://fcm.example",
      fetch: fcm.fetch,
    });
    const message = { collapseKey: "robin/trip", data: { roomId: "trip" } };
    expect(await sender.send("device-1", message)).toBe("sent");
    fcm.gone.add("device-2");
    expect(await sender.send("device-2", message)).toBe("gone");
    expect(fcm.exchanges).toHaveLength(1);
    expect(fcm.sent[0]!.message).toEqual({
      token: "device-1",
      data: { roomId: "trip" },
      android: { priority: "high", collapse_key: "robin/trip", ttl: "86400s" },
    });
    const exchange = fcm.exchanges[0]!;
    expect(exchange.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [head, claims, signature] = exchange.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({
      iss: account.client_email,
      aud: account.token_uri,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${claims}`),
        createPublicKey(account.private_key),
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });
});

describe("native push through the server", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let tokens: Record<string, string>;
  let faux: ReturnType<typeof fauxProvider>;
  let apns: Awaited<ReturnType<typeof fakeApns>>;
  let fcm: ReturnType<typeof fakeFcm>;

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
    return { status: response.status, json: text === "" ? undefined : JSON.parse(text) };
  };

  /** An assistant with the push extension and these settings, served. */
  const start = async (settings: Record<string, unknown>) => {
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
            extension: pushExtension({
              fetch: fcm.fetch,
              apnsOrigins: apns.origins,
              fcmOrigin: "https://fcm.example",
            }),
            settings: { subject: "mailto:owner@nudge.example", ...settings },
          },
        ],
      },
      context,
    );
    tokens = {};
    for (const name of ["Ann", "Bo", "Cy"])
      tokens[name] = (await nudge.players.invite(name, context)).token;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
    server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
  };

  beforeEach(async () => {
    apns = await fakeApns();
    fcm = fakeFcm();
    const dir = mkdtempSync(join(tmpdir(), "nudge-push-"));
    const keyFile = join(dir, "AuthKey.p8");
    const serviceAccountFile = join(dir, "service-account.json");
    writeFileSync(keyFile, apnsKey());
    writeFileSync(serviceAccountFile, JSON.stringify(serviceAccount()));
    await start({
      apns: { keyFile, keyId: "KEY123", teamId: "TEAM456", bundleId: "app.nudge.dev" },
      fcm: { serviceAccountFile },
    });
  });

  afterEach(async () => {
    await server.close();
    await nudge.close(context);
    await apns.close();
  });

  it("registers devices and pushes a room's answers to its members' devices", async () => {
    expect((await call("GET", "/ext/push/devices", tokens.Ann!)).json).toEqual({
      apns: true,
      fcm: true,
      relays: [],
    });
    const ann = "a1".repeat(32);
    expect(
      (
        await call("POST", "/ext/push/devices", tokens.Ann!, {
          platform: "apns",
          token: ann,
          environment: "sandbox",
        })
      ).status,
    ).toBe(204);
    expect(
      (await call("POST", "/ext/push/devices", tokens.Bo!, { platform: "fcm", token: "bo-phone" }))
        .status,
    ).toBe(204);
    expect(
      (await call("POST", "/ext/push/devices", tokens.Cy!, { platform: "fcm", token: "cy-phone" }))
        .status,
    ).toBe(204);
    expect(
      (await call("POST", "/ext/push/devices", tokens.Cy!, { platform: "apns", token: "nope" }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", "/ext/push/devices", tokens.Cy!, { platform: "web", token: "x" })).status,
    ).toBe(400);

    faux.setResponses([fauxAssistantMessage("The train leaves at 09:12.")]);
    await call("POST", "/rooms/trip/messages", tokens.Ann!, { text: "Train?", requestId: "r1" });
    await until(() => apns.received.length === 1 && fcm.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fcm.sent.map((s) => s.token)).toEqual(["bo-phone"]);
    expect(fcm.sent[0]!.message.data).toEqual({
      assistant: "robin",
      roomId: "trip",
      kind: "answer",
      url: "/robin/trip",
      title: "Robin · Trip",
      body: "New message",
      tag: "robin/trip",
    });
    expect(apns.received[0]!.headers[":path"]).toBe(`/3/device/${ann}`);
    expect(apns.received[0]!.body).toMatchObject({
      aps: { alert: { title: "Robin · Trip", body: "New message" } },
      assistant: "robin",
      roomId: "trip",
      kind: "answer",
    });

    expect((await call("DELETE", `/ext/push/devices/${ann}`, tokens.Ann!)).status).toBe(204);
    expect((await call("DELETE", `/ext/push/devices/${ann}`, tokens.Ann!)).status).toBe(404);
  });

  it("skips devices of players with the room open, and forgets gone devices", async () => {
    await call("POST", "/ext/push/devices", tokens.Ann!, { platform: "fcm", token: "ann-phone" });
    await call("POST", "/ext/push/devices", tokens.Bo!, { platform: "fcm", token: "bo-phone" });
    fcm.gone.add("bo-phone");

    // Ann has the room open in the app.
    const socket = new WebSocket(`${server.url.replace("http", "ws")}/v1/a/robin/connect`);
    const frames: { type: string }[] = [];
    socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    const client = { name: "test", version: "0", platform: "test" };
    socket.send(JSON.stringify({ type: "hello", protocol: 1, token: tokens.Ann, client }));
    await until(() => frames.some((f) => f.type === "welcome"));
    socket.send(JSON.stringify({ type: "subscribe", target: "room:trip" }));
    await until(() => frames.some((f) => f.type === "snapshot"));

    faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Again.")]);
    await call("POST", "/rooms/trip/messages", tokens.Ann!, { text: "Hi", requestId: "r1" });
    await until(() => fcm.sent.length === 1);
    expect(fcm.sent[0]!.token).toBe("bo-phone");
    await until(
      async () => (await nudge.harness.snapshot(PushDoc, "bo", context))?.devices?.length === 0,
    );

    // Closed the room: Ann's phone gets the next one.
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await call("POST", "/rooms/trip/messages", tokens.Ann!, { text: "Hi", requestId: "r2" });
    await until(() => fcm.sent.length === 2);
    expect(fcm.sent[1]!.token).toBe("ann-phone");
  });

  it("refuses devices for a platform the server doesn't push to", async () => {
    await server.close();
    await nudge.close(context);
    await start({});
    expect((await call("GET", "/ext/push/devices", tokens.Ann!)).json).toEqual({
      apns: false,
      fcm: false,
      relays: [],
    });
    const refused = await call("POST", "/ext/push/devices", tokens.Ann!, {
      platform: "fcm",
      token: "x",
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/FCM/);
  });
});
