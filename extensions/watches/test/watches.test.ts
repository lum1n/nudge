import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import {
  createNudge,
  defineNudgeExtension,
  defineTool,
  LOBBY,
  type Nudge,
  readsOnly,
  type RoomEvent,
  roomOf,
  Type,
} from "@nudge/core";
import { scriptsExtension } from "@nudge/ext-scripts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFound, parseReport, remember, WatchesDoc, watchesExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "owner", displayName: "Vegard" };
const ann = { playerId: "ann", displayName: "Ann" };

function lastUser(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "user");
  return typeof message?.content === "string"
    ? message.content
    : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function until(check: () => boolean | Promise<boolean>, timeout = 8_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("watches", () => {
  let nudge: Nudge;
  /** What a check finds now, as the site would list it. */
  let listings: { key: string; text: string }[];
  let checks: number;
  /** More the check's reply says beside its items. */
  let extra: JsonObject;
  let events: RoomEvent[];

  beforeEach(async () => {
    listings = [{ key: "https://finn.example/1", text: "GLC 2027, 780 000 kr" }];
    checks = 0;
    extra = {};
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = (request: ModelContext) => {
      // The harness may add a system note after a tool's result.
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult")
        return fauxAssistantMessage([
          fauxText(last.content.map((p) => (p.type === "text" ? p.text : "")).join("")),
        ]);
      const text = lastUser(request);
      if (text.includes("scheduled check for a watch")) {
        checks++;
        return fauxAssistantMessage([
          fauxText(
            `I looked.\n\`\`\`json\n${JSON.stringify({ items: listings, ...extra })}\n\`\`\``,
          ),
        ]);
      }
      if (text.includes("found something new"))
        return fauxAssistantMessage([fauxText(`News! ${text.split("\n").slice(1, -1).join(" ")}`)]);
      if (/watch for/i.test(text))
        return fauxAssistantMessage(
          [
            fauxToolCall("add_watch", {
              what: "New GLC 2027 under 800 000 kr on finn",
              every_minutes: 0.01,
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (/stop watching/i.test(text))
        return fauxAssistantMessage([fauxToolCall("remove_watch", { id: "w1" })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage([fauxText("Okay.")]);
    };
    faux.setResponses(Array.from({ length: 200 }, () => answer));
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [{ extension: watchesExtension, settings: { minMinutes: 0 } }],
      },
      context,
    );
    events = [];
    nudge.events.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    await nudge.close(context);
  });

  const say = async (text: string) => {
    const settled = await (await nudge.submit(LOBBY, { text, author: by }, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
  };
  const watch = async () => (await nudge.harness.snapshot(WatchesDoc, LOBBY, context))?.items[0];

  it("checks on a schedule out of the room's sight, and tells the room only what is new", async () => {
    await say("Watch for new GLC 2027 listings under 800 000 kr on finn, often");
    await until(() => events.some((e) => e.type === "answer" && e.cause === "nudge"));
    const first = events.find((e) => e.type === "answer" && e.cause === "nudge")!;
    expect(first).toMatchObject({ text: expect.stringContaining("GLC 2027, 780 000 kr") });

    // More checks with the same listing tell the room nothing.
    await until(async () => ((await watch())?.checks ?? 0) >= 3);
    expect(events.filter((e) => e.type === "answer" && e.cause === "nudge")).toHaveLength(1);

    listings = [...listings, { key: "https://finn.example/2", text: "GLC 2027, 799 000 kr" }];
    await until(
      () => events.filter((e) => e.type === "answer" && e.cause === "nudge").length === 2,
    );
    const second = events.filter((e) => e.type === "answer" && e.cause === "nudge")[1]!;
    expect(second.type === "answer" && second.text).toContain("799 000 kr");
    expect(second.type === "answer" && second.text).not.toContain("780 000 kr");
    expect((await watch())?.seen).toEqual(["https://finn.example/1", "https://finn.example/2"]);

    // The checks ran in a side conversation of the room: tools there see the room, the room
    // doesn't see them.
    const [sideId] = await nudge.rooms.sides(LOBBY, context);
    expect((await roomOf(nudge.harness, sideId!, context)).id).toBe(LOBBY);
    const room = await nudge.conversation(LOBBY, context);
    const entries = (await room.entries({ order: "ascending" }, 500, undefined, context)).items;
    expect(JSON.stringify(entries)).not.toContain("scheduled check for a watch");
    expect(entries.filter((e) => e.kind === "nudge.fire")).toHaveLength(2);

    await say("Stop watching that");
    expect(await watch()).toBeUndefined();
    expect(await nudge.rooms.sides(LOBBY, context)).toEqual([]);
    const after = checks;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(checks).toBe(after);
  });

  it("answers a model check's news itself, also when the reply has a message", async () => {
    extra = { message: "Posted as it is" };
    await say("Watch for new GLC 2027 listings under 800 000 kr on finn, often");
    await until(() => events.some((e) => e.type === "answer" && e.cause === "nudge"));
    const first = events.find((e) => e.type === "answer" && e.cause === "nudge")!;
    expect(first).toMatchObject({ text: expect.stringContaining("News!") });
    const room = await nudge.conversation(LOBBY, context);
    const entries = (await room.entries({ order: "ascending" }, 500, undefined, context)).items;
    const fires = entries.filter((e) => e.kind === "nudge.fire");
    expect(fires).toHaveLength(1);
    expect(fires[0]!.data).not.toHaveProperty("said");
  });

  it("reads the items out of a reply, and remembers keys once", () => {
    expect(
      parseFound('Found these:\n{"items":[{"key":"a","text":"A"},{"key":"","text":"x"}]}'),
    ).toEqual([{ key: "a", text: "A" }]);
    expect(parseFound('{"items":[]} trailing')).toEqual([]);
    expect(parseFound("No JSON here {not json}")).toBeUndefined();
    expect(parseReport('Output:\n{"message":"Two new","items":[{"key":"a"}]}')).toEqual({
      items: [{ key: "a", text: "a" }],
      message: "Two new",
    });
    expect(remember(["a"], ["b", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("watches that run a script", () => {
  let nudge: Nudge;
  let listings: string[];
  /** Model requests, of any kind. */
  let requests: number;
  let calls: { name: string; args: JsonObject }[];
  let events: RoomEvent[];

  const site = defineNudgeExtension({
    name: "site",
    version: "0.0.0",
    setup: () => ({
      tools: [
        readsOnly(
          defineTool({
            name: "listings",
            description: "List what is for sale.",
            parameters: Type.Object({}),
            execute: async () => ({ output: [{ type: "text", text: listings.join("\n") }] }),
          }),
        ),
      ],
    }),
  });

  const open = async (database: string, scripts: boolean) => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = (request: ModelContext) => {
      requests++;
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("Done.")]);
      const text = lastUser(request);
      if (text.includes("found something new"))
        return fauxAssistantMessage([fauxText(`News! ${text.split("\n").slice(1, -1).join(" ")}`)]);
      const call = calls.shift();
      if (call === undefined) return fauxAssistantMessage([fauxText("Okay.")]);
      return fauxAssistantMessage([fauxToolCall(call.name, call.args)], { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 200 }, () => answer));
    nudge = await createNudge(
      {
        database,
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          site,
          ...(scripts ? [scriptsExtension] : []),
          { extension: watchesExtension, settings: { minScriptMinutes: 0 } },
        ],
      },
      context,
    );
    events = [];
    nudge.events.subscribe((event) => events.push(event));
  };

  beforeEach(async () => {
    listings = ["GLC 2027, 780 000 kr"];
    requests = 0;
    calls = [];
    await open(":memory:", true);
  });

  afterEach(async () => {
    await nudge.close(context);
  });

  const ask = async (name: string, args: JsonObject, as: { private?: true } = {}) => {
    calls.push({ name, args });
    const author = as.private === undefined ? by : ann;
    const settled = await (
      await nudge.submit(LOBBY, { text: "go", author, ...as }, context)
    ).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
  };
  const watch = async () => (await nudge.harness.snapshot(WatchesDoc, LOBBY, context))?.items[0];
  const news = () => events.filter((e) => e.type === "answer" && e.cause === "nudge");

  const watchWith = async (code: string) => {
    await ask("save_script", { name: "glc", description: "GLC listings", code });
    await ask("add_watch", { what: "New GLC listings", every_minutes: 0.01, script: "glc" });
  };
  const LIST =
    "const all = (await tools.listings({})).split('\\n');\n" +
    "const items = all.map((line) => ({ key: line, text: line }));\n";

  it("checks with no model run, and the model speaks only on news", async () => {
    await watchWith(`${LIST}return { items };`);
    await until(() => news().length === 1);
    expect(news()[0]).toMatchObject({ text: expect.stringContaining("GLC 2027, 780 000 kr") });

    // Checks with nothing new cost no model request at all.
    await until(async () => ((await watch())?.checks ?? 0) >= 2);
    const quiet = requests;
    await until(async () => ((await watch())?.checks ?? 0) >= 6);
    expect(requests).toBe(quiet);
    expect(news()).toHaveLength(1);
    expect(await nudge.rooms.sides(LOBBY, context)).toEqual([]);

    listings = [...listings, "GLC 2027, 799 000 kr"];
    await until(() => news().length === 2);
    expect(requests).toBe(quiet + 1);
    expect(news()[1]).toMatchObject({ text: expect.stringContaining("799 000 kr") });
  });

  it("posts a script's own message with no model at all", async () => {
    await watchWith(
      `${LIST}return { items, message: items.length + " GLC listings now: " + all.join("; ") };`,
    );
    await until(() => news().length === 1);
    const after = requests;
    expect(news()[0]).toMatchObject({ text: "1 GLC listings now: GLC 2027, 780 000 kr" });

    listings = [...listings, "GLC 2027, 799 000 kr"];
    await until(() => news().length === 2);
    expect(news()[1]).toMatchObject({ text: expect.stringContaining("2 GLC listings now") });
    expect(requests).toBe(after);

    const room = await nudge.conversation(LOBBY, context);
    const entries = (await room.entries({ order: "ascending" }, 500, undefined, context)).items;
    expect(entries.filter((e) => e.kind === "nudge.fire")).toHaveLength(2);
  });

  it("notes a script that fails, and keeps checking", async () => {
    await ask("save_script", {
      name: "glc",
      description: "GLC listings",
      code: `${LIST}if (all.join("") === "") throw new Error("site down");\nreturn { items };`,
    });
    listings = [];
    await ask("add_watch", { what: "New GLC listings", every_minutes: 0.01, script: "glc" });
    await until(async () => ((await watch())?.checks ?? 0) >= 2);
    expect((await watch())?.lastError).toContain("site down");
    expect(news()).toHaveLength(0);
  });

  it("runs a public watch's script in public, whatever the room said last", async () => {
    await ask("schedule_nudge", { message: "Walk the dog", in_minutes: 600 });
    await ask("save_script", {
      name: "nudges",
      description: "The room's nudges",
      code: "const all = await tools.list_nudges({});\nreturn { items: [{ key: all, text: all }] };",
    });
    await ask("add_watch", { what: "New nudges", every_minutes: 0.01, script: "nudges" });
    await until(async () => ((await watch())?.seen ?? []).some((k) => k.includes("Walk the dog")));

    // Ann's private nudge is the newest thing in the room; the watch's checks still don't see it.
    await ask("schedule_nudge", { message: "Dentist at 9", in_minutes: 600 }, { private: true });
    const before = (await watch())?.checks ?? 0;
    await until(async () => ((await watch())?.checks ?? 0) >= before + 3);
    expect((await watch())?.lastError).toBeUndefined();
    expect(JSON.stringify((await watch())?.seen)).not.toContain("Dentist");
    expect(JSON.stringify(news())).not.toContain("Dentist");
  });

  it("notes a watch whose script is gone", async () => {
    await watchWith(`${LIST}return { items };`);
    await until(() => news().length === 1);
    await ask("remove_script", { name: "glc" });
    await until(async () => ((await watch())?.lastError ?? "").includes("No script glc"));
  });

  it("notes a watch whose script can't run with the scripts extension off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-watches-"));
    try {
      await nudge.close(context);
      await open(join(dir, "nudge.db"), true);
      await ask("save_script", {
        name: "glc",
        description: "GLC listings",
        code: `${LIST}return { items };`,
      });
      await ask("add_watch", { what: "New GLC listings", every_minutes: 0.05, script: "glc" });
      await until(async () => ((await watch())?.checks ?? 0) >= 1);
      await nudge.close(context);

      await open(join(dir, "nudge.db"), false);
      await until(async () =>
        ((await watch())?.lastError ?? "").includes("scripts extension is off"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("won't watch with a script that isn't saved", async () => {
    await ask("add_watch", { what: "x", every_minutes: 1, script: "nope" });
    expect(await watch()).toBeUndefined();
  });
});
