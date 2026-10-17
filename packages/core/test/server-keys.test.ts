import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildModels, ServerKeys } from "../src/index.ts";

describe("ServerKeys", () => {
  let dir: string;
  let env: Record<string, string[]>;
  const keys = () => new ServerKeys(join(dir, "server", "keys"), (provider) => env[provider] ?? []);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-keys-"));
    env = {};
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("keeps keys encrypted on disk, for every assistant or one", async () => {
    keys().set("anthropic", "sk-ant-server");
    keys().set("anthropic", "sk-ant-robin", "robin");
    const file = join(dir, "server", "keys", "secrets.enc");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("sk-ant");

    const store = keys();
    expect(await store.credentialsFor("robin").read("anthropic")).toEqual({
      type: "api_key",
      key: "sk-ant-robin",
    });
    expect(await store.credentialsFor("pocket").read("anthropic")).toEqual({
      type: "api_key",
      key: "sk-ant-server",
    });
    expect(store.source("anthropic", "robin")).toEqual({ from: "assistant" });
    expect(store.source("anthropic", "pocket")).toEqual({ from: "server" });
    expect(store.source("openai", "pocket")).toBeUndefined();
    expect(store.providers("robin")).toEqual(["anthropic"]);
  });

  it("leaves a provider to the environment when its variable is set", async () => {
    const store = keys();
    store.set("anthropic", "sk-ant-server");
    env.anthropic = ["ANTHROPIC_API_KEY"];
    expect(store.source("anthropic")).toEqual({ from: "env", variables: ["ANTHROPIC_API_KEY"] });
    expect(await store.credentialsFor("robin").read("anthropic")).toBeUndefined();
  });

  it("forgets an assistant's keys, and keeps the server's", async () => {
    const store = keys();
    store.set("anthropic", "sk-ant-server");
    store.set("openai", "sk-robin", "robin");
    store.deleteAssistant("robin");
    expect(store.providers("robin")).toEqual(["anthropic"]);
    expect(store.delete("anthropic")).toBe(true);
    expect(store.delete("anthropic")).toBe(false);
  });

  it("is where the model catalog finds a provider's key", async () => {
    const store = keys();
    store.set("openai", "sk-openai-test");
    const models = buildModels([], store.credentialsFor("robin"));
    const model = models.getModel("openai", "gpt-5-mini");
    expect(model).toBeDefined();
    const auth = await models.getAuth(model!);
    expect(auth?.auth.apiKey).toBe("sk-openai-test");
  });
});
