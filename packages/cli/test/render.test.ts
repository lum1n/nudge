import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY, type Nudge } from "@nudge/core";
import type { RoomView, TimelineItem } from "@nudge/protocol";
import { Hubs } from "@nudge/server";
import { describe, expect, it } from "vitest";
import { ChatRenderer } from "../src/render.ts";

const context = BACKGROUND_CONTEXT;
// oxlint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\x1b\[\d+m/g, "");

async function fauxNudge(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  faux = fauxProvider({ tokensPerSecond: 2000, tokenSize: { min: 2, max: 4 } }),
): Promise<Nudge> {
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return createNudge(
    {
      database: ":memory:",
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      settings: { progress: { partialIntervalMs: 20 } },
    },
    context,
  );
}

/** Renders the lobby's views as the in-process chat does; `stop` returns what was printed. */
async function render(nudge: Nudge, renderer: ChatRenderer) {
  const lease = (await new Hubs(nudge, (error) => {
    throw error;
  }).room(LOBBY))!;
  let views = 0;
  const unlisten = lease.hub.listen({
    changed: () => {
      views++;
      renderer.update(lease.hub.view());
    },
    ended: () => {},
  });
  renderer.history(lease.hub.view());
  return {
    views: () => views,
    stop: () => {
      unlisten();
      lease.release();
    },
  };
}

/** The renderer's own client: what it sends is already on screen. */
const me = { playerId: "ann", displayName: "Ann", clientId: "mine" };

const view = (timeline: TimelineItem[], running = false): RoomView => ({
  room: { id: "lobby", kind: "lobby", name: "Lobby", members: [] },
  timeline,
  hasEarlier: false,
  live: { running },
  queue: [],
  approvals: [],
  memory: [],
  nudges: [],
});

describe("ChatRenderer", () => {
  it("streams answers and shows messages from other clients", async () => {
    const nudge = await fauxNudge([
      fauxAssistantMessage("Hello there, Ann and Bo."),
      fauxAssistantMessage("Sure."),
    ]);
    let out = "";
    const watching = await render(
      nudge,
      new ChatRenderer((text) => (out += text), "Nudge", "mine"),
    );

    const ann = { playerId: "ann", displayName: "Ann", clientId: "mine" };
    const bo = { playerId: "bo", displayName: "Bo", clientId: "theirs" };
    await (await nudge.submit(LOBBY, { text: "hi", author: ann }, context)).wait(context);
    await (await nudge.submit(LOBBY, { text: "help?", author: bo }, context)).wait(context);
    await nudge.harness.waitForIdle(context);
    watching.stop();
    await nudge.close(context);

    expect(plain(out)).toBe("Nudge: Hello there, Ann and Bo.\nBo: help?\nNudge: Sure.\n");
  });

  it("prints a slow answer as it grows, once", async () => {
    const text =
      "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen.";
    const nudge = await fauxNudge(
      [fauxAssistantMessage(text)],
      fauxProvider({ tokensPerSecond: 60, tokenSize: { min: 1, max: 2 } }),
    );
    let out = "";
    let writes = 0;
    const renderer = new ChatRenderer(
      (chunk) => {
        writes++;
        out += chunk;
      },
      "Nudge",
      "mine",
    );
    const watching = await render(nudge, renderer);
    await (await nudge.submit(LOBBY, { text: "count", author: me }, context)).wait(context);
    await nudge.harness.waitForIdle(context);
    watching.stop();
    await nudge.close(context);

    expect(writes).toBeGreaterThan(3);
    expect(plain(out)).toBe(`Nudge: ${text}\n`);
  });

  it("announces tool calls between the answer's texts", async () => {
    const nudge = await fauxNudge([
      fauxAssistantMessage(
        [fauxText("Let me note that."), fauxToolCall("remember", { fact: "Ann likes tea" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Noted."),
    ]);
    let out = "";
    const watching = await render(
      nudge,
      new ChatRenderer((text) => (out += text), "Nudge", "mine"),
    );
    await (await nudge.submit(LOBBY, { text: "I like tea", author: me }, context)).wait(context);
    await nudge.harness.waitForIdle(context);
    watching.stop();
    await nudge.close(context);

    expect(plain(out)).toBe("Nudge: Let me note that.\n  · remember\nNudge: Noted.\n");
  });

  it("shows history dimmed, then the answer still running", () => {
    let out = "";
    const renderer = new ChatRenderer((text) => (out += text), "Nudge", "me");
    const answer = (status: "running" | "done", text: string): TimelineItem => ({
      type: "answer",
      id: "answer:entry:3",
      status,
      parts: [{ type: "text", text }],
    });
    const before: TimelineItem[] = [
      { type: "user", id: "entry:1", text: "hi", author: { id: "ann", displayName: "Ann" } },
      {
        type: "answer",
        id: "answer:entry:1",
        status: "done",
        parts: [{ type: "text", text: "Hello." }],
      },
      { type: "nudge", id: "entry:3", text: "Tea time", firedAt: 1 },
    ];
    renderer.history(view([...before, answer("running", "It's")], true));
    expect(renderer.busy).toBe(true);
    expect(renderer.update(view([...before, answer("running", "It's tea")], true))).toBe(false);
    expect(renderer.update(view([...before, answer("done", "It's tea time.")]))).toBe(true);
    expect(renderer.busy).toBe(false);
    // Nothing printed twice.
    renderer.update(view([...before, answer("done", "It's tea time.")]));

    expect(plain(out)).toBe("Ann: hi\nNudge: Hello.\nnudge: Tea time\nNudge: It's tea time.\n");
    expect(out).toContain("\x1b[2mAnn: hi\x1b[22m");
  });

  it("shows what a running tool is doing, each step once", () => {
    let out = "";
    const renderer = new ChatRenderer((text) => (out += text), "Nudge", "me");
    renderer.history(view([]));
    const browsing = (output: string | undefined, status: "running" | "done" = "running") =>
      view(
        [
          {
            type: "answer",
            id: "a",
            status: "running",
            parts: [
              {
                type: "tool",
                callId: "c1",
                name: "browse",
                args: { task: "Find a GLC" },
                status,
                ...(output === undefined ? {} : { output }),
                ...(status === "done" ? { result: "Found three." } : {}),
              },
            ],
          },
        ],
        true,
      );
    renderer.update(browsing(undefined));
    renderer.update(browsing("Starting the browser…\n"));
    renderer.update(browsing("Starting the browser…\nOpening finn.no…\n"));
    renderer.update(browsing("Starting the browser…\nOpening finn.no…\n"));
    renderer.update(browsing('Starting the browser…\nOpening finn.no…\nClicking "Search"…\n'));
    renderer.update(browsing(undefined, "done"));
    expect(plain(out)).toBe(
      '  · browse\n    Starting the browser…\n    Opening finn.no…\n    Clicking "Search"…\n',
    );
  });

  it("says when an answer failed or stopped, and when a model call is retried", () => {
    let out = "";
    const renderer = new ChatRenderer((text) => (out += text), "Nudge", "me");
    renderer.history(view([]));
    const retrying = view([], true);
    renderer.update({
      ...retrying,
      live: { running: true, status: { kind: "retrying", attempt: 1, at: 0, error: "overloaded" } },
    });
    renderer.update({
      ...retrying,
      live: { running: true, status: { kind: "retrying", attempt: 1, at: 0, error: "overloaded" } },
    });
    renderer.update(
      view([
        { type: "answer", id: "a", status: "failed", error: "no credit", parts: [] },
        { type: "user", id: "u", text: "again", clientId: "me" },
        { type: "answer", id: "b", status: "stopped", parts: [{ type: "text", text: "Part" }] },
      ]),
    );
    expect(plain(out)).toBe(
      "  · retrying (overloaded)\n  ! failed: no credit\nNudge: Part\n  · stopped\n",
    );
  });
});
