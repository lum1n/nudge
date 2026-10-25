import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Assistants,
  BACKGROUND_CONTEXT,
  BackupError,
  openAssistant,
  ServerIdentity,
  ServerKeys,
  ServerOwners,
} from "@nudge/core";
import { createModels, fauxProvider } from "@nudge/core/testing";
import { type BackupState, ServerAssistant } from "@nudge/protocol";
import type { Hono } from "hono";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type ServerControl } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const client = { name: "test", platform: "node" };

/** How the server reaches owners' homes, as each test says. */
let homes: typeof fetch = async () => new Response(null, { status: 404 });

describe("the server API", () => {
  let dir: string;
  let assistants: Assistants;
  let control: ServerControl;
  let app: Hono;
  let ann: string;
  let bo: string;
  const backedUp: string[] = [];
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };

  const call = async (
    method: string,
    path: string,
    { token, body }: { token?: string; body?: unknown } = {},
  ) => {
    const response = await app.request(`http://nudge.test/v1${path}`, {
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
  const signIn = async (token = ann) =>
    (await call("POST", "/server/session", { token, body: { assistant: "robin", client } })).json
      .token as string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-server-api-"));
    backedUp.length = 0;
    const configPath = join(dir, "nudge.json");
    await writeFile(configPath, JSON.stringify({ assistants: [{ name: "robin", model }] }));
    assistants = await Assistants.open({
      configPath,
      open: (config, assistant) => openAssistant(config, assistant, context, { models }),
      context,
    });
    control = {
      assistants,
      keys: new ServerKeys(undefined, () => []),
      owners: new ServerOwners(undefined),
      identity: new ServerIdentity(undefined),
      fetch: (input, init) => homes(input, init),
      backupBeforeDelete: async (config) => {
        backedUp.push(...config.assistants.map((a) => a.name));
        return "nudge-1.nudgebackup";
      },
      testKey: async (_provider, key) => {
        if (key !== "good") throw new Error("invalid x-api-key");
      },
      backupKey: async () => Buffer.alloc(32, 1),
    };
    app = createApp({ assistants: assistants.running, server: control });
    const robin = assistants.running.get("robin")!;
    const first = await robin.players.invite("Ann", context);
    ann = first.token;
    bo = (await robin.players.invite("Bo", context)).token;
    control.owners.add("robin", first.player.id);
  });

  afterEach(async () => {
    await assistants.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("lets an owner trade their player token for a server token, and no one else", async () => {
    expect((await call("GET", "/server")).status).toBe(401);
    expect(
      (await call("POST", "/server/session", { token: bo, body: { assistant: "robin", client } }))
        .status,
    ).toBe(403);
    expect(
      (
        await call("POST", "/server/session", {
          token: "nope",
          body: { assistant: "robin", client },
        })
      ).status,
    ).toBe(401);
    const token = await signIn();
    expect(token).toMatch(/^nudge_server_/);
    // A server token is no player token, and a player token is no server token.
    expect((await call("GET", "/a/robin/me", { token })).status).toBe(401);
    expect((await call("GET", "/server", { token: ann })).status).toBe(401);
    const info = await call("GET", "/server", { token });
    expect(info.json).toMatchObject({
      owner: { assistant: "robin", playerId: "ann" },
      assistants: [{ name: "robin", displayName: "Robin", running: true }],
    });
    expect((await call("DELETE", "/server/session", { token })).status).toBe(204);
    expect((await call("GET", "/server", { token })).status).toBe(401);
  });

  it("creates an assistant as someone's home, with a code to pair their app", async () => {
    const token = await signIn();
    const created = await call("POST", "/server/assistants", {
      token,
      body: { name: "kari", displayName: "Kari's", model, firstPlayer: { displayName: "Kari" } },
    });
    expect(created.status).toBe(201);
    expect(created.json.assistant).toMatchObject({ name: "kari", displayName: "Kari's" });
    expect(created.json.pairing.link).toMatch(/^nudge:\/\/pair\?server=http%3A%2F%2Fnudge\.test/);
    const paired = await call("POST", "/a/kari/pair", {
      body: { code: created.json.pairing.code, client },
    });
    expect(paired.status).toBe(200);
    const me = await call("GET", "/a/kari/me", { token: paired.json.token });
    expect(me.json).toMatchObject({ player: { displayName: "Kari" }, admin: true });

    expect(
      (await call("POST", "/server/assistants", { token, body: { name: "kari" } })).status,
    ).toBe(409);
    expect(
      (await call("POST", "/server/assistants", { token, body: { name: "Not OK" } })).status,
    ).toBe(400);
  });

  it("makes an assistant for the owner, with federation, and invites them from home", async () => {
    const token = await signIn();
    // Without a public address there is no federation, so no one to invite.
    expect(
      (
        await call("POST", "/server/assistants", {
          token,
          body: { name: "work", model, invite: "ann@home.example/robin" },
        })
      ).status,
    ).toBe(400);

    // As in a checkout, where the federation extension is beside the config.
    await mkdir(join(dir, "extensions"));
    await symlink(
      fileURLToPath(new URL("../../../extensions/federation", import.meta.url)),
      join(dir, "extensions", "federation"),
    );
    app = createApp({
      assistants: assistants.running,
      server: control,
      publicUrl: "https://robin.example",
    });
    const created = await call("POST", "/server/assistants", {
      token,
      body: { name: "work", model, invite: "ann@home.example/robin" },
    });
    expect(created.status).toBe(201);
    expect(created.json.joinLink).toBe(
      "nudge://join?server=https%3A%2F%2Frobin.example&assistant=work",
    );
    const config = JSON.parse(readFileSync(join(dir, "nudge.json"), "utf8"));
    // Bundled, or beside the config where the install has no bundle.
    expect(config.assistants[1].extensions).toEqual([
      { from: expect.stringMatching(/federation$/), settings: { server: "https://robin.example" } },
    ]);

    // An assistant made before can invite its owner from home later, as setup's first one.
    const again = await call("POST", "/server/assistants/work/invites", {
      token,
      body: { address: "ann@home.example/robin" },
    });
    expect(again.status).toBe(201);
    expect(again.json.joinLink).toBe(created.json.joinLink);
    expect(
      (
        await call("POST", "/server/assistants/robin/invites", {
          token,
          body: { address: "ann@home.example/robin" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/server/assistants/nobody/invites", {
          token,
          body: { address: "ann@home.example/robin" },
        })
      ).status,
    ).toBe(404);
  });

  it("changes an assistant's settings while it runs", async () => {
    const token = await signIn();
    const changed = await call("PATCH", "/server/assistants/robin", {
      token,
      body: { displayName: "Robin Hood", instructions: "Be brief." },
    });
    expect(changed.json).toMatchObject({ displayName: "Robin Hood", instructions: "Be brief." });
    expect((await call("GET", "/a/robin/me", { token: ann })).status).toBe(200);
    // The budget is replaced whole, `warnUsd` included, and comes back as it was set.
    const budget = { perPlayerUsd: 5, warnAt: 0.5, warnUsd: 40 };
    const budgeted = await call("PATCH", "/server/assistants/robin", { token, body: { budget } });
    expect(budgeted.status).toBe(200);
    expect(Value.Check(ServerAssistant, budgeted.json)).toBe(true);
    expect(budgeted.json.budget).toEqual(budget);
    const listed = await call("GET", "/server/assistants", { token });
    expect(listed.json.assistants.find((a: { name: string }) => a.name === "robin").budget).toEqual(
      budget,
    );
    expect(
      (
        await call("PATCH", "/server/assistants/robin", {
          token,
          body: { budget: { warnUsd: 0 } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("PATCH", "/server/assistants/nobody", { token, body: { displayName: "x" } }))
        .status,
    ).toBe(404);
  });

  it("deletes an assistant after a backup, but not the one every owner is from", async () => {
    const token = await signIn();
    await call("POST", "/server/assistants", { token, body: { name: "pocket", model } });
    const refused = await call("DELETE", "/server/assistants/robin", { token });
    expect(refused.status).toBe(409);
    const deleted = await call("DELETE", "/server/assistants/pocket", { token });
    expect(deleted.json).toEqual({ backup: "nudge-1.nudgebackup" });
    expect(backedUp).toEqual(["pocket"]);
    expect(assistants.running.has("pocket")).toBe(false);
    expect((await call("GET", "/a/pocket/me", { token: ann })).status).toBe(404);
  });

  it("keeps model keys it tested, and never shows them", async () => {
    const token = await signIn();
    expect((await call("GET", "/server/keys", { token })).json.keys).toEqual([
      { provider: "anthropic", source: "none" },
      { provider: "openai", source: "none" },
    ]);
    const bad = await call("PUT", "/server/keys/anthropic", { token, body: { key: "bad" } });
    expect(bad).toMatchObject({ status: 400, json: { error: expect.stringMatching(/x-api-key/) } });
    const good = await call("PUT", "/server/keys/anthropic", { token, body: { key: "good" } });
    expect(good.json).toEqual({ provider: "anthropic", source: "server" });
    await call("PUT", "/server/keys/openai", {
      token,
      body: { key: "untested", test: false, assistant: "robin" },
    });
    const listed = await call("GET", "/server/keys?assistant=robin", { token });
    expect(listed.json.keys).toEqual([
      { provider: "anthropic", source: "server" },
      { provider: "openai", source: "assistant" },
    ]);
    expect(JSON.stringify(listed.json)).not.toContain("good");
    expect((await call("DELETE", "/server/keys/anthropic", { token })).status).toBe(204);
    expect((await call("DELETE", "/server/keys/anthropic", { token })).status).toBe(404);
  });

  it("adds owners from the server's players, and keeps at least one", async () => {
    const token = await signIn();
    expect(
      (await call("POST", "/server/owners", { token, body: { assistant: "robin", playerId: "x" } }))
        .status,
    ).toBe(404);
    const added = await call("POST", "/server/owners", {
      token,
      body: { assistant: "robin", playerId: "bo" },
    });
    expect(added.status).toBe(201);
    const owners = (await call("GET", "/server/owners", { token })).json.owners as { id: string }[];
    expect(owners).toHaveLength(2);
    expect((await call("DELETE", `/server/owners/${added.json.id}`, { token })).status).toBe(204);
    const last = owners.find((o) => o.id !== added.json.id)!;
    expect((await call("DELETE", `/server/owners/${last.id}`, { token })).status).toBe(409);

    // As for someone who joined from home: an owner, and an admin of the assistant too.
    expect((await call("GET", "/a/robin/admin/players", { token: bo })).status).toBe(403);
    await call("POST", "/server/owners", {
      token,
      body: { assistant: "robin", playerId: "bo", admin: true },
    });
    expect((await call("GET", "/a/robin/admin/players", { token: bo })).status).toBe(200);
  });

  it("shows its own keys to anyone, and adds owners whose home is elsewhere by address", async () => {
    const key = await call("GET", "/server/key");
    expect(key).toMatchObject({
      status: 200,
      json: { signingKey: expect.any(String), encryptionKey: expect.any(String) },
    });
    const token = await signIn();
    const add = (body: unknown) => call("POST", "/server/owners", { token, body });
    expect((await add({})).status).toBe(400);
    expect((await add({ address: "nobody" })).status).toBe(400);
    // Their home must answer with its keys, to pin them.
    homes = async () => new Response(null, { status: 404 });
    expect((await add({ address: "vegard@home.example/robin" })).status).toBe(502);
    homes = async (input) => {
      expect(String(input)).toBe("https://home.example/v1/a/robin/ext/federation/key");
      return Response.json({
        server: "https://home.example",
        assistant: "robin",
        signingKey: "sign",
        encryptionKey: "seal",
      });
    };
    const added = await add({ address: "vegard@home.example/robin" });
    expect(added).toMatchObject({
      status: 201,
      json: { address: "vegard@home.example/robin", addedAt: expect.any(Number) },
    });
    // Their home's keys stay on the server.
    const listed = (await call("GET", "/server/owners", { token })).json;
    expect(JSON.stringify(listed)).not.toContain("seal");
    expect(
      control.owners.ownerAt({
        server: "https://home.example",
        assistant: "robin",
        playerId: "vegard",
      })?.keys,
    ).toEqual({ signingKey: "sign", encryptionKey: "seal" });
    // They keep the server when every assistant here goes.
    expect(control.owners.wouldLeaveNoOwner("robin")).toBe(false);
  });

  it("shows the backups and sets where they are copied, for owners", async () => {
    const token = await signIn();
    expect((await call("GET", "/server/backups", { token })).status).toBe(404);
    const asked: unknown[] = [];
    let state: BackupState = { on: true, dir: "/data/backups", everyHours: 24, keep: 14 };
    app = createApp({
      assistants: assistants.running,
      server: {
        ...control,
        backups: {
          state: async () => state,
          setRemote: async (change) => {
            asked.push(change);
            if (change.type === "webdav" && change.secret === "wrong")
              throw new BackupError("Nudge couldn't write there: PUT /dav/: 401");
            const { user, secret: _, test: __, ...remote } = change;
            state = { ...state, remote, credentials: { user: user!, from: "server" } };
            return state;
          },
          removeRemote: async () => {
            const { remote: _, credentials: __, ...rest } = state;
            return (state = rest);
          },
          backUpNow: async () => ({ file: "nudge-20261024T100000Z.nudgebackup" }),
        },
      },
    });
    expect((await call("GET", "/server/backups")).status).toBe(401);
    expect((await call("GET", "/server/backups", { token })).json).toEqual(state);
    const target = { type: "s3", endpoint: "https://s3.example", bucket: "vault" };
    const set = await call("PUT", "/server/backups/remote", {
      token,
      body: { ...target, user: "AKID", secret: "shh" },
    });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ remote: target, credentials: { user: "AKID" } });
    // The secret never comes back.
    expect(JSON.stringify(set.json)).not.toContain("shh");
    expect(
      (await call("PUT", "/server/backups/remote", { token, body: { type: "ftp", url: "x" } }))
        .status,
    ).toBe(400);
    const refused = await call("PUT", "/server/backups/remote", {
      token,
      body: { type: "webdav", url: "https://dav.example/", user: "ann", secret: "wrong" },
    });
    expect(refused).toEqual({
      status: 400,
      json: { error: "Nudge couldn't write there: PUT /dav/: 401" },
    });
    expect((await call("POST", "/server/backups", { token })).json).toEqual({
      file: "nudge-20261024T100000Z.nudgebackup",
    });
    const removed = await call("DELETE", "/server/backups/remote", { token });
    expect(removed.json.remote).toBeUndefined();
    expect(asked).toHaveLength(2);
  });

  it("turns Wired on, or joins, under the name an owner picked", async () => {
    const asked: unknown[] = [];
    const state = { state: "starting" as const };
    app = createApp({
      assistants: assistants.running,
      server: {
        ...control,
        wired: {
          state: () => ({ state: "off", name: "robin" }),
          enable: async (name) => (asked.push(["enable", name]), state),
          join: async (invite, options) => (asked.push(["join", invite, options]), state),
          addRelay: async () => "wired1abc",
          remove: async () => state,
          disable: async () => state,
        },
      },
    });
    const token = await signIn();
    expect((await call("GET", "/server/wired", { token })).json).toEqual({
      state: "off",
      name: "robin",
    });
    // As before: no body, and the server's own name.
    expect((await call("POST", "/server/wired", { token })).status).toBe(200);
    expect((await call("POST", "/server/wired", { token, body: { name: "box" } })).status).toBe(
      200,
    );
    expect((await call("POST", "/server/wired", { token, body: { name: "Box!" } })).status).toBe(
      400,
    );
    expect((await call("POST", "/server/wired", { token, body: { name: "-box" } })).status).toBe(
      400,
    );
    const joined = await call("POST", "/server/wired/join", {
      token,
      body: { invite: "wired1abc", name: "box" },
    });
    expect(joined.status).toBe(200);
    expect(asked).toEqual([
      ["enable", undefined],
      ["enable", "box"],
      ["join", "wired1abc", { name: "box" }],
    ]);
  });
});
