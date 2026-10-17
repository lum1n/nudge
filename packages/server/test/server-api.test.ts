import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Assistants, openAssistant, ServerKeys, ServerOwners } from "@nudge/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type ServerControl } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const client = { name: "test", platform: "node" };

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
  });

  it("changes an assistant's settings while it runs", async () => {
    const token = await signIn();
    const changed = await call("PATCH", "/server/assistants/robin", {
      token,
      body: { displayName: "Robin Hood", instructions: "Be brief." },
    });
    expect(changed.json).toMatchObject({ displayName: "Robin Hood", instructions: "Be brief." });
    expect((await call("GET", "/a/robin/me", { token: ann })).status).toBe(200);
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
  });
});
