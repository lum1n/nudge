import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY, type Nudge, type RoomEvent, roomOf } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFound, remember, WatchesDoc, watchesExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "owner", displayName: "Vegard" };

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
  let events: RoomEvent[];

  beforeEach(async () => {
    listings = [{ key: "https://finn.example/1", text: "GLC 2027, 780 000 kr" }];
    checks = 0;
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
          fauxText(`I looked.\n\`\`\`json\n${JSON.stringify({ items: listings })}\n\`\`\``),
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

  it("reads the items out of a reply, and remembers keys once", () => {
    expect(
      parseFound('Found these:\n{"items":[{"key":"a","text":"A"},{"key":"","text":"x"}]}'),
    ).toEqual([{ key: "a", text: "A" }]);
    expect(parseFound('{"items":[]} trailing')).toEqual([]);
    expect(parseFound("No JSON here {not json}")).toBeUndefined();
    expect(remember(["a"], ["b", "a", "b"])).toEqual(["a", "b"]);
  });
});
