import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import hello from "../../../extensions/hello/src/index.ts";
import {
  ConfigError,
  createNudge,
  defineNudgeExtension,
  defineTool,
  LOBBY,
  loadExtensions,
  type Nudge,
  type NudgeOptions,
  parseConfig,
  section,
  Type,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const HELLO = resolve(import.meta.dirname, "../../../extensions/hello/src/index.ts");

function setup(extra: Partial<NudgeOptions> = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: ModelContext[] = [];
  faux.setResponses(
    Array.from({ length: 20 }, () => (request: ModelContext) => {
      requests.push(request);
      return fauxAssistantMessage("Sure.");
    }),
  );
  const options: NudgeOptions = {
    database: ":memory:",
    models,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    timeZone: "Europe/Oslo",
    ...extra,
  };
  /** What the provider got in the last request, as one string. */
  const last = () => JSON.stringify(requests.at(-1));
  return { faux, options, requests, last };
}

async function say(nudge: Nudge, text: string, roomId = LOBBY): Promise<void> {
  const author = { playerId: "owner", displayName: "Vegard" };
  const settled = await (await nudge.submit(roomId, { text, author }, context)).wait(context);
  if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
}

/**
 * The tools and prompt in effect at the end of a request. Pi Durable sends changes to either as
 * later system messages, so they are replayed in order.
 */
function current(request: ModelContext | undefined): { tools: string[]; prompt: string } {
  const tools = new Set<string>();
  const sections: Record<string, string> = {};
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const [key, text] of Object.entries(message.sections ?? {}))
      if (text === null) delete sections[key];
      else sections[key] = text;
  }
  return { tools: [...tools], prompt: Object.values(sections).join("\n") };
}

/** The text of the request's last tool result. */
function lastToolResult(request: ModelContext): string | undefined {
  const message = request.messages.findLast((m) => m.role === "toolResult");
  const block = message?.content[0];
  return block?.type === "text" ? block.text : undefined;
}

describe("extensions", () => {
  it("installs a Nudge extension with its settings: section, tool and detector", async () => {
    const { options, requests, last } = setup({
      extensions: [{ extension: hello, settings: { greeting: "Hei og hå" } }],
    });
    const nudge = await createNudge(options, context);
    expect(nudge.extensions()).toEqual([{ name: "hello", version: "0.1.0" }]);
    await say(nudge, "My car is EV 12345.");
    expect(current(requests.at(-1)).prompt).toContain('answer with "Hei og hå" first');
    expect(current(requests.at(-1)).tools).toContain("roll_dice");
    expect(last()).not.toContain("EV 12345");
    expect(last()).toContain("⟦PLATE1⟧");
    await nudge.close(context);
  });

  it("fills in default settings and refuses bad ones", async () => {
    const { options, requests } = setup({ extensions: [hello] });
    const nudge = await createNudge(options, context);
    await say(nudge, "Hi");
    expect(current(requests.at(-1)).prompt).toContain('answer with "Hello" first');
    await nudge.close(context);

    await expect(
      createNudge(
        { ...options, extensions: [{ extension: hello, settings: { maxSides: 1 } }] },
        context,
      ),
    ).rejects.toThrow(/Invalid settings for extension "hello":\n {2}\/maxSides/);
    const plain = defineNudgeExtension({ name: "plain", version: "1", setup: () => ({}) });
    await expect(
      createNudge({ ...options, extensions: [{ extension: plain, settings: { a: 1 } }] }, context),
    ).rejects.toThrow(ConfigError);
  });

  it("keeps the built-in name and unique names", async () => {
    expect(() =>
      defineNudgeExtension({ name: "nudge", version: "1", setup: () => ({}) }),
    ).toThrow();
    expect(() =>
      defineNudgeExtension({ name: "Bad Name", version: "1", setup: () => ({}) }),
    ).toThrow();
    const { options } = setup({ extensions: [hello, hello] });
    await expect(createNudge(options, context)).rejects.toThrow(/installed twice/);
  });

  it("reloads in place: replaces, adds and removes, and changes nothing when one fails", async () => {
    const { options, requests, last } = setup({ extensions: [hello] });
    const nudge = await createNudge(options, context);
    const extra = defineNudgeExtension({
      name: "extra",
      version: "2.0.0",
      setup: () => ({
        sections: [section("extra", () => "Extra section here.")],
        tools: [
          defineTool({
            name: "noop",
            description: "Does nothing",
            parameters: Type.Object({}),
            execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
          }),
        ],
      }),
    });

    expect(
      await nudge.reloadExtensions([{ extension: hello, settings: { greeting: "Morn" } }, extra]),
    ).toEqual([
      { name: "hello", version: "0.1.0" },
      { name: "extra", version: "2.0.0" },
    ]);
    await say(nudge, "Hi");
    expect(current(requests.at(-1)).prompt).toContain('answer with "Morn" first');
    expect(current(requests.at(-1)).prompt).toContain("Extra section here.");
    expect(current(requests.at(-1)).tools).toEqual(expect.arrayContaining(["roll_dice", "noop"]));

    const broken = defineNudgeExtension({
      name: "broken",
      version: "1",
      setup: () => {
        throw new Error("no");
      },
    });
    await expect(nudge.reloadExtensions([extra, broken])).rejects.toThrow("no");
    expect(nudge.extensions().map((e) => e.name)).toEqual(["hello", "extra"]);

    await nudge.reloadExtensions([extra]);
    await say(nudge, "My car is EV 12345.");
    expect(current(requests.at(-1)).tools).not.toContain("roll_dice");
    expect(current(requests.at(-1)).prompt).not.toContain("Morn");
    // The plate detector left with hello.
    expect(last()).toContain("EV 12345");
    await nudge.close(context);
  });

  it("lets an extension protect values once the assistant is open", async () => {
    let protect: ((value: string, kind?: string) => Promise<string>) | undefined;
    const contacts = defineNudgeExtension({
      name: "contacts",
      version: "1",
      setup: (host) => {
        protect = host.protect;
        return {};
      },
    });
    const { options, last } = setup({ extensions: [contacts] });
    const nudge = await createNudge(options, context);
    expect(await protect!("Storgata 1", "ADDRESS")).toBe("⟦ADDRESS1⟧");
    await say(nudge, "I live in Storgata 1.");
    expect(last()).toContain("I live in ⟦ADDRESS1⟧.");
    await nudge.close(context);
  });
});

describe("loading extensions", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-ext-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves paths against the config file and loads them", async () => {
    await writeFile(join(dir, "plain.mjs"), 'export default { name: "plain", sections: [] };\n');
    const config = parseConfig(
      {
        assistants: [
          {
            name: "a",
            extensions: [
              { from: "./plain.mjs" },
              { from: HELLO, settings: { greeting: "Hoi" } },
              { from: "./plain.mjs", enabled: false },
            ],
          },
        ],
      },
      dir,
    );
    const entries = config.assistants[0]!.extensions!;
    expect(entries[0]!.from).toBe(join(dir, "plain.mjs"));
    const loaded = await loadExtensions(entries);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ name: "plain" });
    expect(loaded[1]).toMatchObject({
      extension: { kind: "nudge.extension", name: "hello" },
      settings: { greeting: "Hoi" },
    });
  });

  it("refuses missing files, modules without an extension, and settings for plain ones", async () => {
    expect(() =>
      parseConfig({ assistants: [{ name: "a", extensions: [{ from: "./nope.js" }] }] }, dir),
    ).toThrow(ConfigError);
    await writeFile(join(dir, "empty.mjs"), "export const x = 1;\n");
    await expect(loadExtensions([{ from: join(dir, "empty.mjs") }])).rejects.toThrow(
      /exports no extension/,
    );
    await writeFile(join(dir, "plain.mjs"), 'export default { name: "plain" };\n');
    await expect(
      loadExtensions([{ from: join(dir, "plain.mjs"), settings: { a: 1 } }]),
    ).rejects.toThrow(/takes no settings/);
  });

  it("imports a changed file again when asked for fresh modules", async () => {
    const file = join(dir, "changing.mjs");
    const write = (version: string) =>
      writeFile(
        file,
        `export default { kind: "nudge.extension", name: "changing", version: "${version}", setup: () => ({}) };\n`,
      );
    await write("1");
    const first = await loadExtensions([{ from: file }]);
    await write("2");
    const cached = await loadExtensions([{ from: file }]);
    const fresh = await loadExtensions([{ from: file }], { fresh: true });
    const version = (loaded: typeof first) =>
      (loaded[0] as { extension: { version: string } }).extension.version;
    expect([version(first), version(cached), version(fresh)]).toEqual(["1", "1", "2"]);
  });
});

describe("memory", () => {
  it("remembers per room: the model adds and forgets, and only that room sees it", async () => {
    const { faux, options, requests } = setup();
    const nudge = await createNudge(options, context);
    const ann = await nudge.players.ensure("ann", "Ann", context);
    const annsRoom = await nudge.rooms.ensurePersonal(ann.id, context);
    const author = { playerId: ann.id, displayName: ann.displayName };
    const outputs: string[] = [];
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => () =>
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    const done = (request: ModelContext) => {
      requests.push(request);
      outputs.push(lastToolResult(request) ?? "");
      return fauxAssistantMessage([fauxText("Noted.")]);
    };
    const plain = (request: ModelContext) => {
      requests.push(request);
      return fauxAssistantMessage("Sure.");
    };
    const send = async (roomId: string, text: string) =>
      (await nudge.submit(roomId, { text, author }, context)).wait(context);

    faux.setResponses([
      call("remember", { fact: "Ann is vegetarian" }),
      done,
      call("remember", { fact: "Ann's sister is called Eli" }),
      done,
      plain,
      plain,
    ]);
    await send(annsRoom.id, "I'm vegetarian");
    await send(annsRoom.id, "My sister is Eli");
    expect(outputs).toEqual(["Remembered m1.", "Remembered m2."]);
    await send(annsRoom.id, "What do you know?");
    expect(current(requests.at(-1)).prompt).toContain("- m1: ⟦NAME1⟧ is vegetarian");
    await send(LOBBY, "What do you know?");
    expect(JSON.stringify(requests.at(-1))).not.toContain("vegetarian");

    expect(await nudge.memory.list(annsRoom.id, context)).toMatchObject([
      { id: "m1", text: "Ann is vegetarian" },
      { id: "m2", text: "Ann's sister is called Eli" },
    ]);
    // Another room's ids do not exist from the lobby.
    faux.setResponses([call("forget", { id: "m1" }), done, call("forget", { id: "m1" }), done]);
    await send(LOBBY, "Forget m1");
    await send(annsRoom.id, "Forget m1");
    expect(outputs.slice(2)).toEqual(["No fact m1 in this conversation.", "Forgot m1."]);
    expect((await nudge.memory.list(annsRoom.id, context)).map((f) => f.id)).toEqual(["m2"]);

    const added = await nudge.memory.remember(annsRoom.id, "  Likes   tea ", context);
    expect(added).toMatchObject({ id: "m3", text: "Likes tea" });
    expect(await nudge.memory.forget(annsRoom.id, "m9", context)).toBe(false);
    expect(await nudge.memory.forget(annsRoom.id, "m2", context)).toBe(true);
    await expect(nudge.memory.remember("nowhere", "x", context)).rejects.toThrow();
    await nudge.close(context);
  });

  it("survives a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nudge-memory-"));
    try {
      const { options, requests } = setup({ database: join(dir, "a.sqlite") });
      const first = await createNudge(options, context);
      await first.memory.remember(LOBBY, "The wifi password is on the fridge", context);
      await first.close(context);
      const second = await createNudge(options, context);
      expect(await second.memory.list(LOBBY, context)).toMatchObject([{ id: "m1" }]);
      await say(second, "Where is the wifi password?");
      expect(current(requests.at(-1)).prompt).toContain("- m1: The wifi password is on the fridge");
      await second.close(context);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
