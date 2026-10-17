import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge, type Nudge } from "@nudge/core";
import { createApp } from "@nudge/server";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { federationExtension, newKey, publicKeyOf, seal } from "../src/index.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const context = BACKGROUND_CONTEXT;
const HOME = "https://home.example";
const AWAY = "https://away.example";

describe("federation", () => {
  const apps = new Map<string, Hono>();
  const errors: unknown[] = [];
  /** Requests between the two servers, without leaving the process. */
  /** Every body sent to an inbox, as it went. */
  const wire: string[] = [];
  /** While set, messages to inboxes on that server wait in `held` until let go. */
  let holding: string | undefined;
  const held: (() => void)[] = [];
  /** A server whose next inbox message arrives, but whose answer is lost on the way back. */
  let losing: string | undefined;
  /** What a server's `GET /key` says instead, as if someone else answered for it. */
  const keysAt = new Map<string, unknown>();
  const between: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/key") && keysAt.has(url.origin))
      return Response.json(keysAt.get(url.origin));
    const inbox = url.pathname.endsWith("/inbox");
    if (inbox || url.pathname.endsWith("/join")) wire.push(String(init?.body));
    const app = apps.get(url.origin);
    if (app === undefined) throw new Error(`No server at ${url.origin}`);
    if (inbox && holding === url.origin) await new Promise<void>((resolve) => held.push(resolve));
    const response = await app.request(url.toString(), init);
    if (inbox && losing === url.origin) {
      losing = undefined;
      throw new Error("The answer was lost");
    }
    return response;
  };
  let home: Nudge;
  let away: Nudge;
  let vegard: string;
  let ann: string;

  const open = async (name: string, server: string) => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("Hi.")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const nudge = await createNudge(
      {
        name,
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          {
            extension: federationExtension({ fetch: between, report: (e) => errors.push(e) }),
            settings: { server },
          },
        ],
      },
      context,
    );
    apps.set(server, createApp({ assistants: new Map([[name, nudge]]) }));
    return nudge;
  };

  /** A request to `server`'s assistant, as `token`. */
  const call = async (
    server: string,
    method: string,
    path: string,
    { token, body }: { token?: string; body?: unknown } = {},
  ) => {
    const assistant = server === HOME ? "robin" : "team";
    const response = await between(`${server}/v1/a/${assistant}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: (text === "" ? undefined : JSON.parse(text)) as any };
  };

  beforeEach(async () => {
    errors.length = 0;
    wire.length = 0;
    holding = undefined;
    held.length = 0;
    losing = undefined;
    keysAt.clear();
    home = await open("robin", HOME);
    away = await open("team", AWAY);
    vegard = (await home.players.invite("Vegard", context)).token;
    ann = (await away.players.invite("Ann", context)).token;
  });

  afterEach(async () => {
    await home.close(context);
    await away.close(context);
    apps.clear();
    expect(errors).toEqual([]);
  });

  const assertion = async () =>
    (
      await call(HOME, "POST", "/ext/federation/assert", {
        token: vegard,
        body: { server: AWAY, assistant: "team" },
      })
    ).json.assertion;

  it("lets someone an admin invited join from their home, once per assertion", async () => {
    const key = await call(HOME, "GET", "/ext/federation/key");
    expect(key.json).toMatchObject({ server: HOME, assistant: "robin" });

    const first = await assertion();
    expect(
      await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: first } }),
    ).toMatchObject({ status: 403, json: { error: "No invite for vegard@home.example/robin" } });
    expect(
      (
        await call(AWAY, "POST", "/ext/federation/invites", {
          token: ann,
          body: { address: "nobody" },
        })
      ).status,
    ).toBe(400);
    const invited = await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    expect(invited).toMatchObject({
      status: 201,
      json: {
        invite: { address: "vegard@home.example/robin", by: "ann" },
        link: "nudge://join?server=https%3A%2F%2Faway.example&assistant=team",
      },
    });

    const joined = await call(AWAY, "POST", "/ext/federation/join", {
      body: { assertion: first },
    });
    expect(joined).toMatchObject({
      status: 201,
      json: {
        player: { id: "vegard", displayName: "Vegard", address: "vegard@home.example/robin" },
      },
    });
    const token = joined.json.token as string;
    expect((await call(AWAY, "GET", "/me", { token })).json.player).toEqual({
      id: "vegard",
      displayName: "Vegard",
      address: "vegard@home.example/robin",
    });
    // The invite is used up, and so is the assertion.
    expect((await call(AWAY, "GET", "/ext/federation/invites", { token: ann })).json).toEqual({
      invites: [],
    });
    expect(
      (await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: first } })).status,
    ).toBe(401);
    // Coming back, such as from a second device, needs no new invite.
    const again = await call(AWAY, "POST", "/ext/federation/join", {
      body: { assertion: await assertion() },
    });
    expect(again).toMatchObject({ status: 201, json: { player: { id: "vegard" } } });
    expect(again.json.token).not.toBe(token);
    // A guest can't be vouched for by the assistant they visit.
    expect(
      (
        await call(AWAY, "POST", "/ext/federation/assert", {
          token,
          body: { server: HOME, assistant: "robin" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(HOME, "GET", "/ext/federation/memberships", { token: vegard })).json,
    ).toEqual({
      address: "vegard@home.example/robin",
      memberships: [
        { server: AWAY, assistant: "team", since: expect.any(Number), carryMemory: false },
      ],
    });
  });

  it("refuses assertions the home didn't sign, or for another assistant", async () => {
    await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    const sealed = await assertion();
    const tampered = {
      ...sealed,
      data: `${sealed.data[0] === "A" ? "B" : "A"}${sealed.data.slice(1)}`,
    };
    expect(
      await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: tampered } }),
    ).toMatchObject({ status: 400, json: { error: "That was not encrypted for this assistant" } });
    // Encrypted for the right assistant, but signed by someone other than the home.
    const keys = (await call(AWAY, "GET", "/ext/federation/key")).json;
    const now = Date.now();
    const forged = seal(newKey("ed25519"), keys.encryptionKey, {
      kind: "nudge.join",
      home: { server: HOME, assistant: "robin", playerId: "vegard" },
      audience: { server: AWAY, assistant: "team" },
      profile: { displayName: "Mallory" },
      issuedAt: now,
      expiresAt: now + 60_000,
      nonce: randomUUID(),
    });
    expect(
      await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: forged } }),
    ).toMatchObject({ status: 401, json: { error: "The home did not sign that" } });
    const elsewhere = seal(newKey("ed25519"), keys.encryptionKey, {
      kind: "nudge.join",
      home: { server: HOME, assistant: "robin", playerId: "vegard" },
      audience: { server: "https://third.example", assistant: "team" },
      profile: { displayName: "Vegard" },
      issuedAt: now,
      expiresAt: now + 60_000,
      nonce: randomUUID(),
    });
    expect(
      await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: elsewhere } }),
    ).toMatchObject({ status: 400, json: { error: "Not for this assistant" } });
    expect(
      (
        await call(HOME, "POST", "/ext/federation/assert", {
          token: vegard,
          body: { server: "http://10.0.0.1", assistant: "team" },
        })
      ).status,
    ).toBe(400);
  });

  it("sends a changed profile to every assistant the person joined", async () => {
    await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: await assertion() } });

    await call(HOME, "PATCH", "/me/profile", {
      token: vegard,
      body: { displayName: "Vegard S", timeZone: "Europe/Oslo", extensions: {} },
    });
    await expect
      .poll(() => away.profiles.get("vegard", context))
      .toEqual({ displayName: "Vegard S", timeZone: "Europe/Oslo" });

    await call(HOME, "PATCH", "/me/profile", { token: vegard, body: { language: "nb" } });
    await expect
      .poll(async () => (await away.profiles.get("vegard", context))?.language)
      .toBe("nb");
  });

  it("signs the guest out there when they leave at home, until invited again", async () => {
    await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    const guest = (
      await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: await assertion() } })
    ).json.token as string;
    await call(HOME, "PUT", "/ext/federation/memberships/memory", {
      token: vegard,
      body: { server: AWAY, assistant: "team", carry: true },
    });
    await home.memory.rememberFor("vegard", "Likes tea", context);
    await expect
      .poll(async () => (await away.memory.ofPlayer("vegard", context)).facts.length)
      .toBe(1);
    await away.memory.rememberFor("vegard", "Sits by the window", context);
    await expect
      .poll(async () => (await home.memory.ofPlayer("vegard", context)).facts.length)
      .toBe(2);
    const leaving = wire.length;

    expect(
      (
        await call(
          HOME,
          "DELETE",
          "/ext/federation/memberships?server=https://away.example&assistant=team",
          {
            token: vegard,
          },
        )
      ).status,
    ).toBe(204);
    await expect
      .poll(async () => (await call(AWAY, "GET", "/me", { token: guest })).status)
      .toBe(401);
    expect(await away.players.tokens("vegard", context)).toEqual([]);
    expect((await away.memory.ofPlayer("vegard", context)).facts).toEqual([]);
    expect(
      (await call(HOME, "GET", "/ext/federation/memberships", { token: vegard })).json,
    ).toMatchObject({ memberships: [] });
    // The player stays for the rooms' history; their home's word alone no longer lets them in.
    expect(await away.players.get("vegard", context)).toMatchObject({ displayName: "Vegard" });
    expect(
      (await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: await assertion() } }))
        .status,
    ).toBe(403);

    // Invited again, the old leave sent once more doesn't end the new stay.
    await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    const back = (
      await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: await assertion() } })
    ).json.token as string;
    const replayed = wire.slice(leaving).find((body) => body.startsWith('{"message"'))!;
    await between(`${AWAY}/v1/a/team/ext/federation/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: replayed,
    });
    await sleep(20);
    expect((await call(AWAY, "GET", "/me", { token: back })).status).toBe(200);
  });

  it("carries own memory where the person allows it, encrypted, and both ways", async () => {
    await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    const guest = (
      await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: await assertion() } })
    ).json.token as string;
    await home.protect("Storgata 1", "ADDRESS");
    await home.protect("the blue box", "PRIVATE", { owner: "vegard" });
    await home.memory.rememberFor("vegard", "Lives in Storgata 1", context);
    await home.memory.rememberFor("vegard", "Keeps the spare key in the blue box", context);
    // Nothing goes before they say so.
    await sleep(20);
    expect((await away.memory.ofPlayer("vegard", context)).facts).toEqual([]);

    const carry = (on: boolean) =>
      call(HOME, "PUT", "/ext/federation/memberships/memory", {
        token: vegard,
        body: { server: AWAY, assistant: "team", carry: on },
      });
    expect((await carry(true)).json).toMatchObject({ carryMemory: true });
    const away_facts = async () =>
      (await away.memory.ofPlayer("vegard", context)).facts.map((fact) =>
        away.showTo("vegard", fact.text),
      );
    // The private value stays home; the other is protected anew there.
    await expect.poll(away_facts).toEqual(["Lives in Storgata 1"]);
    const [carried] = (await away.memory.ofPlayer("vegard", context)).facts;
    expect(carried!.text).toMatch(/^Lives in ⟦ADDRESS\d+⟧$/);
    for (const body of wire) {
      expect(body).not.toContain("Storgata");
      expect(body).not.toContain(Buffer.from("Storgata").toString("base64url").slice(0, 8));
    }

    // Remembered there, it goes home and comes back from there.
    await away.memory.rememberFor("vegard", "Allergic to nuts", context);
    await expect
      .poll(async () =>
        (await home.memory.ofPlayer("vegard", context)).facts.map((fact) => fact.text),
      )
      .toContain("Allergic to nuts");
    await expect.poll(away_facts).toEqual(["Lives in Storgata 1", "Allergic to nuts"]);
    // Forgotten there, it is forgotten at home.
    const nuts = (await away.memory.ofPlayer("vegard", context)).facts[1]!;
    await away.memory.forgetFor("vegard", nuts.id, context);
    await expect
      .poll(async () =>
        (await home.memory.ofPlayer("vegard", context)).facts.map((fact) => fact.text),
      )
      .not.toContain("Allergic to nuts");

    // Turned off, what came from home leaves; what they remember there stays there.
    await carry(false);
    await expect.poll(away_facts).toEqual([]);
    await away.memory.rememberFor("vegard", "Likes the window seat", context);
    await sleep(20);
    expect((await home.memory.ofPlayer("vegard", context)).facts).toHaveLength(2);
    expect(guest).toBeTypeOf("string");
  });

  it("keeps a fact remembered there while it is on its way home, and takes it once", async () => {
    await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: await assertion() } });
    await call(HOME, "PUT", "/ext/federation/memberships/memory", {
      token: vegard,
      body: { server: AWAY, assistant: "team", carry: true },
    });
    const texts = async (nudge: Nudge) =>
      (await nudge.memory.ofPlayer("vegard", context)).facts.map((fact) => fact.text);

    // A memory the home sent before the fact reached it arrives after it went: the fact stays.
    holding = AWAY;
    await home.memory.rememberFor("vegard", "Likes tea", context);
    await expect.poll(() => held.length).toBe(1);
    await away.memory.rememberFor("vegard", "Allergic to nuts", context);
    held.shift()!();
    await expect.poll(() => texts(away)).toContain("Likes tea");
    expect(await texts(away)).toEqual(["Likes tea", "Allergic to nuts"]);
    // The memory that brings it back from home takes its place.
    await expect.poll(() => held.length).toBe(1);
    holding = undefined;
    held.shift()!();
    await expect.poll(() => texts(home)).toEqual(["Likes tea", "Allergic to nuts"]);
    await sleep(20);
    expect(await texts(away)).toEqual(["Likes tea", "Allergic to nuts"]);

    // Its answer lost, a fact that reached home anyway is there once, on both sides.
    losing = HOME;
    await away.memory.rememberFor("vegard", "Sits by the window", context);
    await expect.poll(() => texts(home)).toContain("Sits by the window");
    await away.memory.rememberFor("vegard", "Takes the stairs", context);
    await expect.poll(() => texts(home)).toContain("Takes the stairs");
    await sleep(20);
    const all = ["Likes tea", "Allergic to nuts", "Sits by the window", "Takes the stairs"];
    expect(await texts(home)).toEqual(all);
    expect(await texts(away)).toEqual(all);
    expect(errors.splice(0)).toEqual([new Error("The answer was lost")]);
  });

  it("follows an assistant's new keys from the old ones, and nothing else", async () => {
    await call(AWAY, "POST", "/ext/federation/invites", {
      token: ann,
      body: { address: "vegard@home.example/robin" },
    });
    await call(AWAY, "POST", "/ext/federation/join", { body: { assertion: await assertion() } });
    await call(HOME, "PUT", "/ext/federation/memberships/memory", {
      token: vegard,
      body: { server: AWAY, assistant: "team", carry: true },
    });
    const texts = async (nudge: Nudge) =>
      (await nudge.memory.ofPlayer("vegard", context)).facts.map((fact) => fact.text);

    // An admin rotates either side.
    const before = (await call(HOME, "GET", "/ext/federation/key")).json;
    expect((await call(AWAY, "POST", "/ext/federation/keys", { token: ann })).status).toBe(200);
    expect((await call(HOME, "POST", "/ext/federation/keys", { token: vegard })).status).toBe(200);
    const after = (await call(HOME, "GET", "/ext/federation/key")).json;
    expect(after.signingKey).not.toBe(before.signingKey);
    expect(after.rotations).toHaveLength(1);

    // Both sides still take each other's word, and messages sealed to old keys still open.
    await call(HOME, "PATCH", "/me/profile", { token: vegard, body: { language: "nb" } });
    await expect
      .poll(async () => (await away.profiles.get("vegard", context))?.language)
      .toBe("nb");
    await away.memory.rememberFor("vegard", "Allergic to nuts", context);
    await expect.poll(() => texts(home)).toEqual(["Allergic to nuts"]);
    await home.memory.rememberFor("vegard", "Likes tea", context);
    await expect.poll(() => texts(away)).toEqual(["Allergic to nuts", "Likes tea"]);

    // A key nobody signed for is refused, also when the home's address answers with it.
    const keys = (await call(AWAY, "GET", "/ext/federation/key")).json;
    const stranger = newKey("ed25519");
    const forged = () =>
      seal(stranger, keys.encryptionKey, {
        kind: "nudge.profile",
        home: { server: HOME, assistant: "robin", playerId: "vegard" },
        audience: { server: AWAY, assistant: "team" },
        profile: { displayName: "Mallory" },
        issuedAt: Date.now() + 1000,
      });
    const inbox = () =>
      call(AWAY, "POST", "/ext/federation/inbox", { body: { message: forged() } });
    expect((await inbox()).status).toBe(401);
    keysAt.set(HOME, { ...after, signingKey: publicKeyOf(stranger), rotations: [] });
    expect((await inbox()).status).toBe(401);
    keysAt.set(HOME, { ...after, signingKey: publicKeyOf(stranger) });
    expect((await inbox()).status).toBe(401);
    await sleep(20);
    expect((await away.profiles.get("vegard", context))?.displayName).toBe("Vegard");
  });
});
