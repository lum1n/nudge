import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY, type Nudge } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listsExtension, type PanelOutput } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "ann", displayName: "Ann" };

function lastUser(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "user");
  return typeof message?.content === "string"
    ? message.content
    : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("lists", () => {
  let nudge: Nudge;
  let requests: ModelContext[];
  /** The tool call the model makes next, by what was said. */
  const calls: Record<string, [string, Parameters<typeof fauxToolCall>[1]]> = {
    "need milk": ["list_add", { list: "Shopping", items: ["milk", "eggs", "Milk"] }],
    "got the milk": ["list_check", { list: "shopping", items: ["MILK", "bread"] }],
    "what's on it": ["list_show", { list: "shopping" }],
    "forget the eggs": ["list_remove", { list: "shopping", items: ["eggs"] }],
    "clean up": ["list_clear", { list: "shopping" }],
  };

  beforeEach(async () => {
    requests = [];
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = (request: ModelContext) => {
      requests.push(request);
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult")
        return fauxAssistantMessage([
          fauxText(last.content.map((p) => (p.type === "text" ? p.text : "")).join("")),
        ]);
      const text = lastUser(request);
      const call = Object.entries(calls).find(([said]) => text.includes(said))?.[1];
      return call === undefined
        ? fauxAssistantMessage([fauxText("Okay.")])
        : fauxAssistantMessage([fauxToolCall(call[0], call[1])], { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 50 }, () => answer));
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        displayName: "Robin",
        extensions: [listsExtension],
      },
      context,
    );
    await nudge.players.invite("Ann", context);
  });

  afterEach(async () => {
    await nudge.close(context);
  });

  const say = async (text: string) => {
    const settled = await (await nudge.submit(LOBBY, { text, author: by }, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
    const last = requests.at(-1)!.messages.findLast((m) => m.role === "toolResult");
    return last?.role === "toolResult"
      ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      : "";
  };

  /** A panel on the room's lists socket, as the web UI opens one. */
  const openPanel = async () => {
    const frames: PanelOutput[] = [];
    const handler = nudge.roomSocket("lists")!;
    const room = (await nudge.rooms.get(LOBBY, context))!;
    const player = (await nudge.players.get("ann", context))!;
    const session = await handler(
      { room, player, admin: false },
      { send: (data) => frames.push(JSON.parse(data) as PanelOutput), close: () => {} },
    );
    const lists = () => frames.filter((f) => f.type === "lists").at(-1);
    return { frames, session, lists };
  };

  it("keeps a list through the model's tools", async () => {
    expect(await say("We need milk and eggs")).toBe("Added to shopping: i1 milk, i2 eggs.");
    expect(await say("I got the milk, and bread")).toBe(
      "Ticked off: milk. Not on the list: bread.",
    );
    expect(await say("what's on it?")).toBe("shopping:\ni1 [x] milk\ni2 [ ] eggs");
    // The section tells the model what lists there are.
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("shopping (1 open)");
    expect(await say("forget the eggs")).toBe("Removed: eggs.");
    expect(await say("clean up the list")).toBe("Cleared 1 done items.");
    expect(await say("what's on it?")).toBe("shopping: (empty)");
  });

  it("shows the lists in a panel, live both ways", async () => {
    const panel = await openPanel();
    expect(panel.lists()).toEqual({ type: "lists", lists: [] });

    // The model adds; the open panel hears about it.
    await say("We need milk and eggs");
    await until(() => (panel.lists()?.type === "lists" && panel.lists()!.lists.length) === 1);
    const shopping = () => (panel.lists() as Extract<PanelOutput, { type: "lists" }>).lists[0]!;
    expect(shopping().items.map((i) => [i.text, i.by])).toEqual([
      ["milk", "Robin"],
      ["eggs", "Robin"],
    ]);

    // A person ticks off and adds in the panel; the model sees it.
    panel.session.receive(JSON.stringify({ type: "toggle", list: "shopping", id: "i1" }));
    panel.session.receive(JSON.stringify({ type: "add", list: "shopping", text: "coffee" }));
    await until(() => shopping().items.length === 3);
    expect(shopping().items.map((i) => [i.text, i.done, i.by])).toEqual([
      ["milk", true, "Robin"],
      ["eggs", false, "Robin"],
      ["coffee", false, "Ann"],
    ]);
    expect(await say("what's on it?")).toBe("shopping:\ni1 [x] milk\ni2 [ ] eggs\ni3 [ ] coffee");

    panel.session.receive(JSON.stringify({ type: "remove", list: "nope", id: "i1" }));
    await until(() => panel.frames.at(-1)?.type === "error");
    expect(panel.frames.at(-1)).toMatchObject({ type: "error", message: 'No list "nope"' });
    panel.session.receive(JSON.stringify({ type: "deleteList", list: "shopping" }));
    await until(
      () => (panel.lists() as Extract<PanelOutput, { type: "lists" }>).lists.length === 0,
    );
    panel.session.close();
  });
});
