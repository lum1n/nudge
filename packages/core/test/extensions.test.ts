import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
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
  ExtensionNotFound,
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

  it("turns extensions on and off per room, with defaults per room kind", async () => {
    const { options, requests } = setup({ extensions: [{ extension: hello, rooms: ["shared"] }] });
    const nudge = await createNudge(options, context);
    await nudge.players.ensure("ann", "Ann", context);
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann"] }, context);
    const tools = () => current(requests.at(-1)).tools;

    await say(nudge, "Hi");
    expect(tools()).not.toContain("roll_dice");
    expect(tools()).toContain("remember");
    await say(nudge, "Hi", "trip");
    expect(tools()).toContain("roll_dice");
    expect(await nudge.roomExtensions(LOBBY, context)).toEqual([
      expect.objectContaining({
        name: "hello",
        version: "0.1.0",
        enabled: false,
        byDefault: false,
      }),
    ]);

    expect(await nudge.setRoomExtension(LOBBY, "hello", true, context)).toMatchObject({
      enabled: true,
      byDefault: false,
    });
    await say(nudge, "Hi");
    expect(tools()).toContain("roll_dice");
    await nudge.setRoomExtension("trip", "hello", false, context);
    await say(nudge, "Hi", "trip");
    expect(tools()).not.toContain("roll_dice");
    await nudge.setRoomExtension("trip", "hello", undefined, context);
    expect(await nudge.extensionEnabled("trip", "hello", context)).toBe(true);
    expect((await nudge.rooms.get("trip", context))?.extensions).toBeUndefined();

    // The built-in extension is always on; unknown ones can't be chosen.
    await expect(nudge.setRoomExtension(LOBBY, "nudge", false, context)).rejects.toThrow(
      ExtensionNotFound,
    );
    await expect(nudge.setRoomExtension(LOBBY, "zed", true, context)).rejects.toThrow(
      ExtensionNotFound,
    );

    // A reload with other defaults reaches existing rooms; a room's own choice stays.
    await nudge.reloadExtensions([{ extension: hello, rooms: ["personal"] }]);
    await say(nudge, "Hi", "trip");
    expect(tools()).not.toContain("roll_dice");
    await say(nudge, "Hi");
    expect(tools()).toContain("roll_dice");
    await nudge.close(context);
  });

  it("closes an extension when a reload replaces it, when one fails, and at close", async () => {
    const closed: string[] = [];
    let setups = 0;
    const closing = (name: string) =>
      defineNudgeExtension({
        name,
        version: "1",
        setup: () => {
          const n = ++setups;
          return { close: () => void closed.push(`${name}#${n}`) };
        },
      });
    const broken = defineNudgeExtension({
      name: "broken",
      version: "1",
      setup: () => {
        throw new Error("no");
      },
    });
    const { options } = setup({ extensions: [closing("a")] });
    const nudge = await createNudge(options, context);
    await nudge.reloadExtensions([closing("a"), closing("b")]);
    expect(closed).toEqual(["a#1"]);
    await expect(nudge.reloadExtensions([closing("c"), broken])).rejects.toThrow("no");
    expect(closed).toEqual(["a#1", "c#4"]);
    await nudge.close(context);
    expect(closed).toEqual(["a#1", "c#4", "a#2", "b#3"]);
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

  it("keeps each player's settings for an extension in their profile, checked on write", async () => {
    expect(() =>
      defineNudgeExtension({
        name: "strict",
        version: "1",
        playerSettings: Type.Object({ units: Type.String() }),
        setup: () => ({}),
      }),
    ).toThrow(/default/);
    let read: ((playerId: string) => Promise<unknown>) | undefined;
    const weather = defineNudgeExtension({
      name: "weather",
      version: "1",
      playerSettings: Type.Object({
        units: Type.Union([Type.Literal("metric"), Type.Literal("imperial")], {
          default: "metric",
        }),
        city: Type.Optional(Type.String()),
      }),
      setup: (host) => {
        read = (playerId) => host.playerSettings(playerId, context);
        return {};
      },
    });
    const plain = defineNudgeExtension({ name: "plain", version: "1", setup: () => ({}) });
    const { options } = setup({ extensions: [weather, plain] });
    const nudge = await createNudge(options, context);
    const ann = (await nudge.players.invite("Ann", context)).player;
    expect(nudge.playerSettings().map(({ name }) => name)).toEqual(["weather"]);

    expect(await read!(ann.id)).toEqual({ units: "metric" });
    expect(await read!("nobody")).toBeUndefined();
    await nudge.profiles.update(ann.id, { extensions: { weather: { city: "Bergen" } } }, context);
    expect(await read!(ann.id)).toEqual({ units: "metric", city: "Bergen" });
    for (const extensions of [
      { weather: { units: "kelvin" } } as Record<string, JsonObject>,
      { plain: { anything: true } },
      { missing: {} },
    ])
      await expect(nudge.profiles.update(ann.id, { extensions }, context)).rejects.toThrow();
    // What the profile keeps is what the player chose; null clears one extension's.
    expect((await nudge.profiles.get(ann.id, context))?.extensions).toEqual({
      weather: { city: "Bergen" },
    });
    await nudge.profiles.update(ann.id, { extensions: { weather: null } }, context);
    expect((await nudge.profiles.get(ann.id, context))?.extensions).toBeUndefined();
    await nudge.close(context);
  });

  it("rolls the dice the asker chose in their profile", async () => {
    const { options, faux } = setup({ extensions: [hello] });
    const nudge = await createNudge(options, context);
    await nudge.players.ensure("owner", "Vegard", context);
    await nudge.profiles.update("owner", { extensions: { hello: { sides: 2 } } }, context);
    const outputs: string[] = [];
    faux.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall("roll_dice", { count: 20 })], {
          stopReason: "toolUse",
        }),
      (request: ModelContext) => {
        outputs.push(lastToolResult(request) ?? "");
        return fauxAssistantMessage("Done.");
      },
    ]);
    await say(nudge, "Roll 20 dice");
    expect(outputs[0]!.split(", ").every((roll) => roll === "1" || roll === "2")).toBe(true);
    await nudge.close(context);
  });

  it("gives each extension its own secret store, encrypted on disk and surviving a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nudge-secrets-ext-"));
    try {
      const keeper = defineNudgeExtension({
        name: "keeper",
        version: "1",
        setup: ({ secrets }) => {
          return {
            tools: [
              defineTool({
                name: "note_key",
                description: "Remember an API key for this room",
                parameters: Type.Object({ key: Type.String() }),
                execute: async ({ key }) => {
                  secrets.set(LOBBY, "api-key", key);
                  return { output: [{ type: "text", text: "noted" }] };
                },
              }),
              defineTool({
                name: "peek_key",
                description: "See what this extension's own store holds for the lobby",
                parameters: Type.Object({}),
                execute: async () => ({
                  output: [{ type: "text", text: secrets.get(LOBBY, "api-key") ?? "none" }],
                }),
              }),
            ],
          };
        },
      });
      const other = defineNudgeExtension({
        name: "other",
        version: "1",
        setup: ({ secrets }) => ({
          tools: [
            defineTool({
              name: "peek_other",
              description: "See what this extension's own store holds for the lobby",
              parameters: Type.Object({}),
              execute: async () => ({
                output: [{ type: "text", text: secrets.get(LOBBY, "api-key") ?? "none" }],
              }),
            }),
          ],
        }),
      });
      const { options, faux, requests } = setup({
        database: join(dir, "a.sqlite"),
        extensions: [keeper, other],
      });
      const call =
        (name: string, args: Parameters<typeof fauxToolCall>[1] = {}) =>
        () =>
          fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
      const outputs: string[] = [];
      const done = (request: ModelContext) => {
        requests.push(request);
        outputs.push(lastToolResult(request) ?? "");
        return fauxAssistantMessage("Done.");
      };

      const first = await createNudge(options, context);
      faux.setResponses([call("note_key", { key: "sk-live-secret" }), done]);
      await say(first, "Remember my key");

      // A different extension has its own store: it never sees "keeper"'s secret.
      faux.setResponses([call("peek_other"), done]);
      await say(first, "Peek from other");

      faux.setResponses([call("peek_key"), done]);
      await say(first, "Peek from keeper");
      expect(outputs).toEqual(["noted", "none", "sk-live-secret"]);

      // Not on disk in the clear.
      const onDisk = readFileSync(
        join(dir, "a.sqlite.extensions", "keeper", "secrets", "secrets.enc"),
        "utf8",
      );
      expect(onDisk).not.toContain("sk-live-secret");
      await first.close(context);

      // Still readable from the extension's own store after a restart.
      const second = await createNudge(options, context);
      faux.setResponses([call("peek_key"), done]);
      await say(second, "Peek again");
      expect(outputs.at(-1)).toBe("sk-live-secret");
      await second.close(context);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
              { from: "./plain.mjs", rooms: ["personal"] },
            ],
          },
        ],
      },
      dir,
    );
    const entries = config.assistants[0]!.extensions!;
    expect(entries[0]!.from).toBe(join(dir, "plain.mjs"));
    const loaded = await loadExtensions(entries);
    expect(loaded).toHaveLength(3);
    expect(loaded[0]).toMatchObject({ name: "plain" });
    expect(loaded[1]).toMatchObject({
      extension: { kind: "nudge.extension", name: "hello" },
      settings: { greeting: "Hoi" },
    });
    expect(loaded[2]).toMatchObject({ extension: { name: "plain" }, rooms: ["personal"] });
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

  it("keeps a player's own facts, shown in their other rooms only once they share them", async () => {
    const { faux, options, requests } = setup();
    const nudge = await createNudge(options, context);
    const ann = await nudge.players.ensure("ann", "Ann", context);
    await nudge.players.ensure("bo", "Bo", context);
    const annsRoom = await nudge.rooms.ensurePersonal(ann.id, context);
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
    await nudge.rooms.createShared({ id: "band", name: "Band", members: ["bo"] }, context);
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
    const prompt = () => current(requests.at(-1)).prompt;

    faux.setResponses([
      call("remember", { fact: "Vegetarian", everywhere: true }),
      done,
      call("remember", { fact: "Likes trains", everywhere: true }),
      done,
      plain,
      plain,
    ]);
    await send(annsRoom.id, "Remember everywhere that I'm vegetarian");
    await send("trip", "Remember everywhere that I like trains");
    expect(outputs).toEqual([
      "Remembered p1.",
      "Only in someone's personal conversation; here, facts belong to this conversation.",
    ]);
    await send(annsRoom.id, "Hi");
    expect(prompt()).toContain("asked you to remember about them");
    expect(prompt()).toContain("- p1: Vegetarian");
    // Not shared yet: other rooms don't see it.
    await send("trip", "Hi");
    expect(prompt()).not.toContain("Vegetarian");
    expect(await nudge.memory.visible("trip", context)).toEqual([]);

    await nudge.memory.share(ann.id, true, context);
    faux.setResponses([plain, plain, call("forget", { id: "p1" }), done]);
    await send("trip", "Hi");
    expect(prompt()).toContain("- p1: Vegetarian");
    await send(LOBBY, "Hi");
    expect(prompt()).toContain("- p1: Vegetarian");
    expect(await nudge.memory.visible("trip", context)).toMatchObject([
      { id: "p1", text: "Vegetarian", owner: { playerId: "ann", displayName: "Ann" } },
    ]);
    expect(await nudge.memory.visible("band", context)).toEqual([]);
    await send("trip", "Forget p1");
    expect(outputs.at(-1)).toContain("they can forget it in their personal conversation");

    const by = { playerId: "ann", displayName: "Ann" };
    expect(await nudge.memory.rememberFor(ann.id, "Lives in Oslo", context, by)).toMatchObject({
      id: "p2",
      by,
    });
    expect(await nudge.memory.ofPlayer(ann.id, context)).toMatchObject({
      shared: true,
      facts: [{ id: "p1" }, { id: "p2" }],
    });
    expect(await nudge.memory.forgetFor(ann.id, "p1", context)).toBe(true);
    expect(await nudge.memory.forgetFor(ann.id, "p1", context)).toBe(false);
    await nudge.memory.share(ann.id, false, context);
    expect(await nudge.memory.visible("trip", context)).toEqual([]);
    expect((await nudge.memory.visible(annsRoom.id, context)).map((f) => f.id)).toEqual(["p2"]);
    await expect(nudge.memory.share("zed", true, context)).rejects.toThrow();
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
