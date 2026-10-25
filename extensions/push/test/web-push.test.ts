import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, createNudge, type Nudge, requestApproval } from "@nudge/core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@nudge/core/testing";
import { type RunningServer, serveNudge } from "@nudge/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateVapidKeys, PushDoc, type PushMessage, pushExtension } from "../src/index.ts";
import { encryptPayload, vapidAuthorization } from "../src/web-push.ts";

const context = BACKGROUND_CONTEXT;

/** A browser's side of a push subscription: its key pair and auth secret. */
function browser(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    subscription: {
      endpoint,
      keys: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") },
    },
    /** What the browser reads out of a push body (RFC 8291). */
    decrypt(body: Buffer): unknown {
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const sender = body.subarray(21, 21 + idlen);
      const sealed = body.subarray(21 + idlen);
      const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
      const expand = (prk: Buffer, info: string | Buffer, length: number) =>
        hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, length);
      const shared = ecdh.computeSecret(sender);
      const ikm = expand(
        hmac(auth, shared),
        Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, sender]),
        32,
      );
      const prk = hmac(salt, ikm);
      const decipher = createDecipheriv(
        "aes-128-gcm",
        expand(prk, "Content-Encoding: aes128gcm\0", 16),
        expand(prk, "Content-Encoding: nonce\0", 12),
      );
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final(),
      ]);
      expect(plain.at(-1)).toBe(2);
      return JSON.parse(plain.subarray(0, -1).toString());
    },
  };
}

describe("web push", () => {
  it("encrypts so only the browser can read it", () => {
    const b = browser("https://push.example/1");
    const body = encryptPayload(b.subscription, Buffer.from(JSON.stringify({ hello: "there" })));
    expect(b.decrypt(body)).toEqual({ hello: "there" });
    expect(body.toString()).not.toContain("there");
  });

  it("signs a VAPID token for the push service's origin", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization("https://push.example/abc", keys, "mailto:a@b.example", 0);
    const [, jwt, k] = /^vapid t=(\S+), k=(\S+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [head, claims, signature] = jwt!.split(".");
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      aud: "https://push.example",
      exp: 12 * 3600,
      sub: "mailto:a@b.example",
    });
    const raw = Buffer.from(keys.publicKey, "base64url");
    const key = createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33).toString("base64url"),
      },
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${claims}`),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("shares one key pair among the assistants beside one database directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-vapid-"));
    const open = (name: string) =>
      createNudge(
        {
          name,
          database: join(dir, `${name}.sqlite`),
          models: createModels(),
          model: { provider: "none", modelId: "none" },
          extensions: [pushExtension()],
        },
        context,
      );
    const robin = await open("robin");
    const wren = await open("wren");
    try {
      const server = await serveNudge({
        assistants: new Map([
          ["robin", robin],
          ["wren", wren],
        ]),
        port: 0,
      });
      try {
        const keyOf = async (nudge: Nudge, name: string) => {
          const { token } = await nudge.players.invite("Ann", context);
          const response = await fetch(`${server.url}/v1/a/${name}/ext/push/web`, {
            headers: { authorization: `Bearer ${token}` },
          });
          return ((await response.json()) as { publicKey: string }).publicKey;
        };
        const key = await keyOf(robin, "robin");
        expect(await keyOf(wren, "wren")).toBe(key);
        const file = JSON.parse(readFileSync(join(dir, "push-vapid.json"), "utf8"));
        expect(file.publicKey).toBe(key);
      } finally {
        await server.close();
      }
    } finally {
      await robin.close(context);
      await wren.close(context);
    }
  });

  describe("through the server", () => {
    let nudge: Nudge;
    let server: RunningServer;
    let tokens: Record<string, string>;
    let faux: ReturnType<typeof fauxProvider>;
    /** What the fake push service got, by endpoint; endpoints in `gone` answer 410. */
    let received: { endpoint: string; body: Buffer; headers: Headers }[];
    let gone: Set<string>;
    /** A fake push service that records what it got. */
    let pushService: typeof fetch;

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

    const until = async (check: () => boolean) => {
      const end = Date.now() + 5_000;
      while (!check()) {
        if (Date.now() > end) throw new Error("Timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    beforeEach(async () => {
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
              extension: pushExtension({ fetch: (input, init) => pushService(input, init) }),
              settings: { preview: "text", subject: "mailto:owner@nudge.example" },
            },
          ],
        },
        context,
      );
      tokens = {};
      for (const name of ["Ann", "Bo", "Cy"])
        tokens[name] = (await nudge.players.invite(name, context)).token;
      await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
      received = [];
      gone = new Set();
      pushService = async (input, init) => {
        const endpoint = String(input);
        received.push({
          endpoint,
          body: Buffer.from(init!.body as Uint8Array),
          headers: new Headers(init!.headers),
        });
        return new Response(null, { status: gone.has(endpoint) ? 410 : 201 });
      };
      server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
    });

    afterEach(async () => {
      await server.close();
      await nudge.close(context);
    });

    it("pushes a room's answers to its members' browsers only", async () => {
      const key = await call("GET", "/ext/push/web", tokens.Ann!);
      expect(key.json.publicKey).toMatch(/^[\w-]{87}$/);
      const ann = browser("https://push.example/ann");
      const bo = browser("https://push.example/bo");
      const cy = browser("https://push.example/cy");
      expect((await call("POST", "/ext/push/web", tokens.Ann!, ann.subscription)).status).toBe(204);
      expect((await call("POST", "/ext/push/web", tokens.Bo!, bo.subscription)).status).toBe(204);
      expect((await call("POST", "/ext/push/web", tokens.Cy!, cy.subscription)).status).toBe(204);
      // The server POSTs to the endpoint, so only a push service on a public name will do.
      for (const endpoint of [
        "http://push.example/x",
        "https://127.0.0.1/x",
        "https://router.lan/x",
      ])
        expect(
          (await call("POST", "/ext/push/web", tokens.Cy!, { ...cy.subscription, endpoint }))
            .status,
        ).toBe(400);

      faux.setResponses([fauxAssistantMessage("The train leaves at 09:12.")]);
      const sent = await call("POST", "/rooms/trip/messages", tokens.Ann!, {
        text: "When is the train?",
        requestId: "r1",
      });
      expect(sent.status).toBeLessThan(300);
      await until(() => received.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received.map((r) => r.endpoint).sort()).toEqual([
        "https://push.example/ann",
        "https://push.example/bo",
      ]);
      const push = received.find((r) => r.endpoint.endsWith("/bo"))!;
      expect(push.headers.get("content-encoding")).toBe("aes128gcm");
      expect(push.headers.get("authorization")).toMatch(/^vapid t=.+, k=.+$/);
      expect(bo.decrypt(push.body)).toEqual({
        title: "Robin · Trip",
        body: "The train leaves at 09:12.",
        url: "/robin/trip",
        tag: "robin/trip",
        kind: "answer",
        roomId: "trip",
      } satisfies PushMessage);
    });

    it("leaves out players who turned a kind of push off in their profile", async () => {
      const ann = browser("https://push.example/ann");
      const bo = browser("https://push.example/bo");
      await call("POST", "/ext/push/web", tokens.Ann!, ann.subscription);
      await call("POST", "/ext/push/web", tokens.Bo!, bo.subscription);
      const off = await call("PATCH", "/me/profile", tokens.Bo!, {
        notifications: { answers: false },
      });
      expect(off.json).toMatchObject({ displayName: "Bo", notifications: { answers: false } });

      faux.setResponses([fauxAssistantMessage("Done.")]);
      await call("POST", "/rooms/trip/messages", tokens.Ann!, { text: "Hi", requestId: "r1" });
      await until(() => received.length === 1);
      await nudge.harness.commit(
        (tx) =>
          requestApproval(
            tx,
            "trip",
            { extension: "x", kind: "y", summary: "Book the hotel", payload: null },
            Date.now(),
          ),
        context,
      );
      await until(() => received.length === 3);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received.map((r) => r.endpoint).sort()).toEqual([
        "https://push.example/ann",
        "https://push.example/ann",
        "https://push.example/bo",
      ]);
    });

    it("swaps a subscription the browser replaced, given the old one's auth secret", async () => {
      const old = browser("https://push.example/old");
      await call("POST", "/ext/push/web", tokens.Ann!, old.subscription);
      const fresh = browser("https://push.example/new");
      const renew = (auth: string, endpoint = old.subscription.endpoint) =>
        fetch(`${server.url}/v1/a/robin/ext/push/web/renew`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ old: { endpoint, auth }, subscription: fresh.subscription }),
        }).then((response) => response.status);
      // Knowing the endpoint is not enough: the push service knows it too.
      expect(await renew(fresh.subscription.keys.auth)).toBe(404);
      expect(await renew(old.subscription.keys.auth, "https://push.example/other")).toBe(404);
      expect(await renew(old.subscription.keys.auth)).toBe(204);
      const doc = await nudge.harness.snapshot(PushDoc, "ann", context);
      expect(doc?.subscriptions?.map((s) => s.endpoint)).toEqual(["https://push.example/new"]);
      // It is gone now, so the old secret works only once.
      expect(await renew(old.subscription.keys.auth)).toBe(404);

      faux.setResponses([fauxAssistantMessage("Done.")]);
      await call("POST", "/rooms/trip/messages", tokens.Ann!, { text: "Hi", requestId: "r1" });
      await until(() => received.length === 1);
      expect(received[0]!.endpoint).toBe("https://push.example/new");
      expect(fresh.decrypt(received[0]!.body)).toMatchObject({ body: "Done." });
    });

    it("pushes approvals, and forgets browsers that left or whose token was revoked", async () => {
      const ann = browser("https://push.example/ann");
      const bo = browser("https://push.example/bo");
      await call("POST", "/ext/push/web", tokens.Ann!, ann.subscription);
      await call("POST", "/ext/push/web", tokens.Bo!, bo.subscription);
      gone.add(ann.subscription.endpoint);
      const bos = await nudge.players.authenticate(tokens.Bo!, context);
      await nudge.players.revoke(bos!.clientId, context);

      await nudge.harness.commit(
        (tx) =>
          requestApproval(
            tx,
            "trip",
            { extension: "x", kind: "y", summary: "Book the hotel", payload: null },
            Date.now(),
          ),
        context,
      );
      await until(() => received.length === 1);
      expect(ann.decrypt(received[0]!.body)).toMatchObject({
        kind: "approval",
        body: "Waiting for approval: Book the hotel",
      });
      // Ann's browser said it's gone, Bo's token is revoked: both subscriptions went.
      let left: number[] = [];
      const end = Date.now() + 5_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 10));
        left = await Promise.all(
          ["ann", "bo"].map(
            async (id) =>
              (await nudge.harness.snapshot(PushDoc, id, context))?.subscriptions.length ?? 0,
          ),
        );
      } while (left.some((n) => n > 0) && Date.now() < end);
      expect(left).toEqual([0, 0]);
      expect(received).toHaveLength(1);
    });
  });
});
