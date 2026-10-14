import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
  createNudge,
  defineNudgeExtension,
  defineTool,
  LOBBY,
  type Nudge,
  type RoomEvent,
  requestApproval,
  roomOf,
  Type,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "owner", displayName: "Vegard" };

/** An extension with an `ask` tool that files an approval, and that records the events it hears. */
function listener(heard: RoomEvent[]) {
  return defineNudgeExtension({
    name: "listener",
    version: "1",
    setup: ({ now }) => ({
      tools: [
        defineTool({
          name: "ask",
          description: "Ask for approval",
          parameters: Type.Object({}),
          execute: async (_args, api, ctx) => {
            const room = await roomOf(api, api.conversationId, ctx);
            const approval = await api.commit(
              (tx) =>
                requestApproval(
                  tx,
                  room.id,
                  { extension: "listener", kind: "do", summary: "Do it", payload: null },
                  now(),
                ),
              ctx,
            );
            return { output: [{ type: "text", text: `Waiting for ${approval.id}.` }] };
          },
        }),
      ],
      approvals: { do: async () => ({ text: "Done." }) },
      onRoomEvent: (event) => {
        heard.push(event);
      },
    }),
  });
}

async function open(heard: RoomEvent[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const nudge = await createNudge(
    {
      database: ":memory:",
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      timeZone: "Europe/Oslo",
      extensions: [listener(heard)],
    },
    context,
  );
  const seen: RoomEvent[] = [];
  nudge.events.subscribe((event) => seen.push(event));
  return { faux, nudge, seen };
}

async function say(nudge: Nudge, roomId: string, text: string): Promise<void> {
  const settled = await (await nudge.submit(roomId, { text, author: by }, context)).wait(context);
  if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
}

async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("room events", () => {
  it("tells of a finished answer once, with the text of all its parts", async () => {
    const heard: RoomEvent[] = [];
    const { faux, nudge, seen } = await open(heard);
    faux.setResponses([
      fauxAssistantMessage([fauxText("Let me ask."), fauxToolCall("ask", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("I asked for approval."),
    ]);
    await say(nudge, LOBBY, "Do it");
    await until(() => heard.length === 2);

    expect(seen).toEqual(heard);
    expect(seen[0]).toMatchObject({
      type: "approval",
      roomId: LOBBY,
      approval: { id: "a1", summary: "Do it", status: "pending" },
    });
    expect(seen[1]).toMatchObject({
      type: "answer",
      roomId: LOBBY,
      text: "Let me ask.\n\nI asked for approval.",
      cause: "message",
      status: "done",
    });

    // Deciding it is no new approval; the room's answer to the outcome says why it answered.
    faux.setResponses([fauxAssistantMessage("All done.")]);
    await nudge.approvals.decide(LOBBY, "a1", { approve: true, by }, context);
    await nudge.harness.waitForIdle(context);
    await until(() => seen.length === 3);
    expect(seen[2]).toMatchObject({ type: "answer", text: "All done.", cause: "approval" });
    await nudge.close(context);
  });

  it("says when an answer is to a fired nudge", async () => {
    const { faux, nudge, seen } = await open([]);
    faux.setResponses([fauxAssistantMessage("Time to water the plants!")]);
    await nudge.nudges.schedule(
      LOBBY,
      { message: "water the plants", fireAt: Date.now() - 1 },
      context,
    );
    await until(() => seen.length === 1);
    expect(seen[0]).toMatchObject({
      type: "answer",
      text: "Time to water the plants!",
      cause: "nudge",
    });
    await nudge.close(context);
  });

  it("reaches an extension only in rooms it is on in", async () => {
    const heard: RoomEvent[] = [];
    const { faux, nudge, seen } = await open(heard);
    const owner = await nudge.players.create("Vegard", context);
    const room = await nudge.rooms.ensurePersonal(owner.id, context);
    await nudge.setRoomExtension(room.id, "listener", false, context);
    faux.setResponses([fauxAssistantMessage("Hi.")]);
    await say(nudge, room.id, "Hello");
    await until(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ type: "answer", roomId: room.id, text: "Hi." });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard).toEqual([]);
    await nudge.close(context);
  });
});
