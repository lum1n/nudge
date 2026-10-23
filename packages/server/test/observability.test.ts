import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  Assistants,
  createLogger,
  ModelErrors,
  openAssistant,
  ServerIdentity,
  ServerKeys,
  ServerOwners,
} from "@nudge/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type ServerControl } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const client = { name: "test", platform: "node" };

describe("observability", () => {
  let dir: string;
  let assistants: Assistants;
  let control: ServerControl;
  let ann: string;
  let now: number;
  let errors: ModelErrors;
  const lines: string[] = [];
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };

  const app = () =>
    createApp({
      assistants: assistants.running,
      server: control,
      modelErrors: errors,
      logger: createLogger({ write: (line) => lines.push(line) }),
    });
  const call = async (
    target: Hono,
    method: string,
    path: string,
    { token, body }: { token?: string; body?: unknown } = {},
  ) => {
    const response = await target.request(`http://nudge.test/v1${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: (text === "" ? undefined : JSON.parse(text)) as any,
    };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-observability-"));
    lines.length = 0;
    now = 1_000_000;
    errors = new ModelErrors(20, () => now);
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
      backupBeforeDelete: async () => "nudge-1.nudgebackup",
      testKey: async () => {},
      backupKey: async () => Buffer.alloc(32, 1),
    };
    const first = await assistants.running.get("robin")!.players.invite("Ann", context);
    ann = first.token;
    control.owners.add("robin", first.player.id);
  });

  afterEach(async () => {
    await assistants.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("answers the health check without a token, naming nothing", async () => {
    const health = await call(app(), "GET", "/health");
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true, assistants: 1 });

    now = Date.now() - 90_500;
    errors.record({ assistant: "robin", provider: "anthropic", model: "m", message: "overloaded" });
    const later = await call(app(), "GET", "/health");
    expect(later.json).toEqual({ ok: true, assistants: 1, lastModelErrorAgeSeconds: 90 });
    expect(later.text).not.toContain("robin");
    expect(later.text).not.toContain("overloaded");
  });

  it("shows owners the last model errors at GET /v1/server", async () => {
    errors.record({ assistant: "robin", provider: "anthropic", model: "m1", message: "first" });
    now += 1000;
    errors.record({
      provider: "openai",
      model: "m2",
      message: "Invalid api key: sk-abcdefghijkl1234",
    });
    const server = app();
    const token = (
      await call(server, "POST", "/server/session", {
        token: ann,
        body: { assistant: "robin", client },
      })
    ).json.token as string;
    const info = await call(server, "GET", "/server", { token });
    expect(info.status).toBe(200);
    expect(info.json.errors).toEqual([
      { at: 1_001_000, provider: "openai", model: "m2", message: expect.any(String) },
      { at: 1_000_000, assistant: "robin", provider: "anthropic", model: "m1", message: "first" },
    ]);
    expect(info.text).not.toContain("sk-abcdefghijkl1234");
    // Not to anyone else.
    expect((await call(server, "GET", "/server")).status).toBe(401);
  });

  it("logs an unexpected error with its route and assistant, not its path's values", async () => {
    const robin = assistants.running.get("robin")!;
    robin.players.isAdmin = async () => {
      throw new Error("Storage broke");
    };
    const failed = await call(app(), "GET", "/a/robin/me?secret=hush", { token: ann });
    expect(failed.status).toBe(500);
    expect(failed.json).toEqual({ error: "Internal error" });
    const line = JSON.parse(lines.at(-1)!);
    expect(line).toMatchObject({
      level: "error",
      msg: "Request failed",
      method: "GET",
      assistant: "robin",
      detail: "Storage broke",
    });
    expect(line.route).toMatch(/:assistant/);
    expect(lines.join("\n")).not.toContain("hush");
    expect(lines.join("\n")).not.toContain(ann);
  });
});
