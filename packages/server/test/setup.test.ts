import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Assistants,
  BACKGROUND_CONTEXT,
  completeSetup,
  federationEndpoint,
  newKey,
  openAssistant,
  openRecoveryKit,
  publicKeyOf,
  seal,
  ServerIdentity,
  ServerKeys,
  ServerOwners,
  SetupCodes,
} from "@nudge/core";
import { createModels, fauxProvider } from "@nudge/core/testing";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const client = { name: "test", platform: "node" };
const CODE = "ABCD-EFGH-JKMN";

describe("setup mode", () => {
  let dir: string;
  let configPath: string;
  let assistants: Assistants;
  let keys: ServerKeys;
  let codes: SetupCodes;
  let owners: ServerOwners;
  let identity: ServerIdentity;
  let app: Hono;
  // Ann's home, which the server reaches while `homeUp`.
  const nest = { server: "https://home.example", assistant: "nest" };
  const nestSigning = newKey("ed25519");
  const nestKeys = {
    signingKey: publicKeyOf(nestSigning),
    encryptionKey: publicKeyOf(newKey("x25519")),
  };
  let homeUp = true;
  const homeFetch = (async (url: string) =>
    homeUp && url === federationEndpoint(nest, "/key")
      ? Response.json({ ...nest, ...nestKeys })
      : new Response(null, { status: 404 })) as typeof fetch;
  /** An owner assertion from Ann's home, as its `/owner-assertion` makes one. */
  const fromHome = ({ to = identity, signer = nestSigning, nonce = randomUUID() } = {}) => {
    const server = to.publicKeys();
    const now = Date.now();
    return seal(signer, server.encryptionKey, {
      kind: "nudge.owner",
      home: { ...nest, playerId: "ann" },
      audience: { server: "https://robin.example", key: server.signingKey },
      issuedAt: now,
      expiresAt: now + 60_000,
      nonce,
    });
  };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await app.request(`http://robin.example/v1${path}`, {
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
  const choices = (extra: Record<string, unknown> = {}) => ({
    code: CODE,
    client,
    assistant: { name: "robin", displayName: "Robin" },
    model,
    key: "good",
    you: { displayName: "Ann" },
    publicUrl: "https://robin.example/",
    ...extra,
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-setup-"));
    configPath = join(dir, "nudge.json");
    assistants = await Assistants.open({
      configPath,
      open: (config, assistant) => openAssistant(config, assistant, context, { models }),
      context,
      allowMissing: true,
    });
    keys = new ServerKeys(join(dir, "server", "keys"), () => []);
    owners = new ServerOwners(join(dir, "server", "owners.json"));
    identity = new ServerIdentity(undefined);
    homeUp = true;
    codes = new SetupCodes(CODE, 3);
    const testKey = async (_provider: string, key: string) => {
      if (key !== "good") throw new Error("invalid x-api-key");
    };
    app = createApp({
      assistants: assistants.running,
      server: {
        assistants,
        keys,
        owners,
        identity,
        backupBeforeDelete: async () => "backup",
        testKey,
        backupKey: async () => Buffer.alloc(32, 7),
      },
      setup: {
        codes,
        offer: async () => ({
          providers: [
            { id: "anthropic", name: "Anthropic", models: [], recommended: "claude-sonnet-5" },
          ],
          local: [
            {
              id: "ollama",
              name: "Ollama",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: ["qwen3"],
            },
          ],
        }),
        testKey,
        complete: (setupChoices, setupClient) =>
          completeSetup(
            { configPath, assistants, keys, owners, identity, fetch: homeFetch },
            setupChoices,
            setupClient,
            context,
          ),
      },
    });
  });

  afterEach(async () => {
    await assistants.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("sets the server up once, with the code, and runs the new assistant at once", async () => {
    expect((await call("GET", "/setup")).json).toMatchObject({
      open: true,
      local: [{ id: "ollama" }],
    });
    expect((await call("POST", "/setup/code", { code: "abcd efgh jkmn" })).status).toBe(204);
    expect(
      (await call("POST", "/setup/key", { code: CODE, provider: "anthropic", key: "bad" })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/setup/key", { code: CODE, provider: "anthropic", key: "good" })).status,
    ).toBe(204);

    const done = await call("POST", "/setup", choices());
    expect(done.status).toBe(201);
    expect(done.json).toMatchObject({ assistant: "robin", player: { displayName: "Ann" } });
    expect((await call("GET", "/a/robin/me", undefined, done.json.token)).json).toMatchObject({
      admin: true,
    });
    const info = await call("GET", "/server", undefined, done.json.serverToken);
    expect(info.json.assistants).toMatchObject([{ name: "robin", displayName: "Robin" }]);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config).toMatchObject({
      server: { publicUrl: "https://robin.example" },
      backup: { dir: "backups", everyHours: 24, keep: 14 },
      assistants: [{ name: "robin", displayName: "Robin", model }],
    });
    expect(keys.source(model.provider)).toEqual({ from: "server" });
    expect(readFileSync(join(dir, "server", "keys", "secrets.enc"), "utf8")).not.toContain("good");

    // Once set up, setup is closed for good.
    expect((await call("GET", "/setup")).json).toEqual({ open: false, providers: [], local: [] });
    expect((await call("POST", "/setup", choices())).status).toBe(410);
  });

  it("closes after a few wrong codes", async () => {
    for (const _ of [1, 2, 3])
      expect((await call("POST", "/setup/code", { code: "WRONG-WRONG-WRNG" })).status).toBe(401);
    expect((await call("POST", "/setup/code", { code: CODE })).status).toBe(410);
    expect(existsSync(configPath)).toBe(false);
  });

  it("refuses a key that doesn't work, and leaves the server to set up again", async () => {
    expect((await call("POST", "/setup", choices({ key: "bad" }))).status).toBe(400);
    expect(existsSync(configPath)).toBe(false);
    expect((await call("POST", "/setup", choices())).status).toBe(201);
  });

  it("uses a model server found on the machine instead of a key", async () => {
    const done = await call(
      "POST",
      "/setup",
      choices({ key: undefined, local: "ollama", model: { provider: "ollama", modelId: "qwen3" } }),
    );
    expect(done.status).toBe(201);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.providers).toEqual([
      { id: "ollama", baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "qwen3" }] },
    ]);
    expect(config.assistants[0].model).toEqual({ provider: "ollama", modelId: "qwen3" });
    expect(keys.providers()).toEqual([]);
  });

  it("hands an owner the recovery kit, sealed with their passphrase", async () => {
    const done = await call("POST", "/setup", choices());
    const kit = await call(
      "POST",
      "/server/recovery-kit",
      { passphrase: "correct horse battery" },
      done.json.serverToken,
    );
    expect(openRecoveryKit(kit.json.kit, "correct horse battery")).toEqual(Buffer.alloc(32, 7));
    expect(() => openRecoveryKit(kit.json.kit, "wrong horse")).toThrow(/passphrase/);
    expect(
      (await call("POST", "/server/recovery-kit", { passphrase: "short" }, done.json.serverToken))
        .status,
    ).toBe(400);
  });

  it("binds the first player to the home it was set up from, and makes its address the owner", async () => {
    const done = await call("POST", "/setup", choices({ federation: false, home: fromHome() }));
    expect(done.status).toBe(201);
    expect(done.json.owner).toMatchObject({ address: "ann@home.example/nest" });
    expect(done.json.owner.assistant).toBeUndefined();
    const me = await call("GET", "/a/robin/me", undefined, done.json.token);
    expect(me.json).toMatchObject({ admin: true, player: { address: "ann@home.example/nest" } });
    expect(owners.list()).toMatchObject([{ address: "ann@home.example/nest", keys: nestKeys }]);
    const ann = await assistants.running.get("robin")!.players.get(done.json.player.id, context);
    expect(ann?.startedFrom).toEqual({ keys: nestKeys });
    expect((await call("GET", "/server", undefined, done.json.serverToken)).status).toBe(200);
  });

  it("keeps the assertion as proof when the home can't be reached yet", async () => {
    homeUp = false;
    const done = await call("POST", "/setup", choices({ home: fromHome() }));
    expect(done.status).toBe(201);
    expect(owners.list()).toMatchObject([{ address: "ann@home.example/nest" }]);
    expect(owners.list()[0]!.keys).toBeUndefined();
    const ann = await assistants.running.get("robin")!.players.get(done.json.player.id, context);
    expect(ann?.startedFrom?.proof).toBeDefined();
    expect(ann?.startedFrom?.keys).toBeUndefined();
  });

  it("refuses an assertion for another server, signed by another key, or used twice", async () => {
    const other = new ServerIdentity(undefined);
    expect((await call("POST", "/setup", choices({ home: fromHome({ to: other }) }))).status).toBe(
      403,
    );
    const forged = fromHome({ signer: newKey("ed25519") });
    expect((await call("POST", "/setup", choices({ home: forged }))).status).toBe(403);
    expect(existsSync(configPath)).toBe(false);
    // One used before, as by a sign-in, is refused; a fresh one still sets it up.
    const nonce = randomUUID();
    owners.useNonce(nonce, Date.now() + 60_000);
    expect((await call("POST", "/setup", choices({ home: fromHome({ nonce }) }))).status).toBe(403);
    expect(existsSync(configPath)).toBe(false);
    expect((await call("POST", "/setup", choices({ home: fromHome() }))).status).toBe(201);
  });
});
