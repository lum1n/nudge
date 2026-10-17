import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Assistants, openAssistant, ServerKeys, ServerOwners } from "@nudge/core";
import { createApp } from "@nudge/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Api, ApiError, memoryTokens, ServerApi } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
let dir: string;
let assistants: Assistants;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nudge-server-client-"));
});
afterEach(async () => {
  await assistants.close();
  await rm(dir, { recursive: true, force: true });
});

it("signs an owner in to the server and manages its assistants", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const configPath = join(dir, "nudge.json");
  await writeFile(configPath, JSON.stringify({ assistants: [{ name: "robin", model }] }));
  assistants = await Assistants.open({
    configPath,
    open: (config, assistant) => openAssistant(config, assistant, context, { models }),
    context,
  });
  const owners = new ServerOwners(undefined);
  const app = createApp({
    assistants: assistants.running,
    server: {
      assistants,
      keys: new ServerKeys(undefined, () => []),
      owners,
      backupBeforeDelete: async () => "backup",
      testKey: async () => {},
    },
  });
  const fetcher: typeof fetch = async (input, init) => app.request(String(input), init);
  const ann = await assistants.running.get("robin")!.players.invite("Ann", context);
  owners.add("robin", ann.player.id);

  const server = new ServerApi({
    server: "http://nudge.test",
    tokens: memoryTokens(),
    fetch: fetcher,
  });
  await expect(server.info()).rejects.toBeInstanceOf(ApiError);
  const session = await server.signIn("robin", ann.token, { name: "test", platform: "node" });
  expect(session.owner.playerId).toBe("ann");
  expect((await server.info()).assistants.map((a) => a.name)).toEqual(["robin"]);

  const created = await server.createAssistant({
    name: "kari",
    model,
    firstPlayer: { displayName: "Kari" },
  });
  const kari = new Api({
    server: "http://nudge.test",
    assistant: "kari",
    tokens: memoryTokens(),
    fetch: fetcher,
  });
  await kari.pair(created.pairing!.code, { name: "test", platform: "node" });
  expect((await kari.me()).admin).toBe(true);

  await server.updateAssistant("kari", { displayName: "Kari's" });
  expect((await server.assistants()).find((a) => a.name === "kari")?.displayName).toBe("Kari's");
  expect((await server.setKey("anthropic", { key: "sk-ant" })).source).toBe("server");
  expect(await server.deleteAssistant("kari")).toBe("backup");
  await server.signOut();
  await expect(server.info()).rejects.toMatchObject({ status: 401 });
});
