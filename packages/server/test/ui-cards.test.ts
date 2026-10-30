import { BACKGROUND_CONTEXT, createNudge, type EntryRecord, type Nudge } from "@nudge/core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@nudge/core/testing";
import { type TimelineItem, type ToolPart, UiCard } from "@nudge/protocol";
import { projectTimeline } from "@nudge/protocol/project";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, serveNudge } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

const TIMES = {
  title: "Pick a time",
  blocks: [{ type: "text", markdown: "Two tables are free." }],
  fields: [
    { name: "guests", label: "Guests", type: "number" },
    { name: "note", label: "Note", type: "text", optional: true },
  ],
  buttons: [
    { id: "early", label: "18:00", style: "primary" },
    { id: "late", label: "20:30" },
    { id: "none", label: "Neither", skipsFields: true },
  ],
};

describe("cards in the chat (ADR 27)", () => {
  let nudge: Nudge;
  let server: RunningServer;
  let tokens: Record<string, string>;

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${server.url}/v1/a/robin${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: (text === "" ? undefined : JSON.parse(text)) as any };
  };

  const idle = async () => (await nudge.conversation("trip", context)).waitForIdle(context);

  const timeline = async (): Promise<TimelineItem[]> => {
    const conversation = await nudge.conversation("trip", context);
    const page = await conversation.entries({}, 500, undefined, context);
    return projectTimeline([...(page.items as EntryRecord[])].reverse());
  };

  const cardPart = async (): Promise<ToolPart> => {
    for (const item of await timeline())
      if (item.type === "answer")
        for (const part of item.parts)
          if (part.type === "tool" && part.name === "show_ui") return part;
    throw new Error("No card");
  };

  const ask = async (name: string, text: string, extra: Record<string, unknown> = {}) => {
    expect(
      (
        await call("POST", "/rooms/trip/messages", tokens[name]!, {
          text,
          requestId: text,
          ...extra,
        })
      ).status,
    ).toBe(202);
    await idle();
  };

  beforeEach(async () => {
    const faux = fauxProvider({ tokensPerSecond: 500 });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText("Here:"),
          fauxToolCall("show_ui", TIMES as unknown as Parameters<typeof fauxToolCall>[1]),
        ],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("Pick one."),
      ...Array.from({ length: 10 }, (_, n) => fauxAssistantMessage(`Answer ${n}.`)),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
      },
      context,
    );
    tokens = {};
    for (const name of ["Ann", "Bo", "Cy"])
      tokens[name] = (await nudge.players.invite(name, context)).token;
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
    server = await serveNudge({ assistants: new Map([["robin", nudge]]), port: 0 });
  });

  afterEach(async () => {
    await server.close();
    await nudge.close(context);
  });

  it("shows the model's card, and a press comes back once as the presser's message", async () => {
    await ask("Ann", "Book us a table");
    const part = await cardPart();
    const card = (part.details as { ui: unknown }).ui;
    expect(Value.Check(UiCard, card)).toBe(true);
    expect(part.pressed).toBeUndefined();

    const path = `/rooms/trip/ui/${part.callId}`;
    expect((await call("POST", path, tokens.Bo!, { button: "nope" })).status).toBe(400);
    expect((await call("POST", path, tokens.Bo!, { button: "early" })).status).toBe(400);
    expect(
      (await call("POST", path, tokens.Bo!, { button: "early", values: { guests: "4" } })).status,
    ).toBe(400);
    expect((await call("POST", path, tokens.Cy!, { button: "early" })).status).toBe(404);
    expect(
      (await call("POST", "/rooms/trip/ui/nope", tokens.Bo!, { button: "early" })).status,
    ).toBe(404);

    const pressed = await call("POST", path, tokens.Bo!, {
      button: "early",
      values: { guests: 4, note: "By the window" },
    });
    expect(pressed.status).toBe(202);
    await idle();
    expect(
      (await call("POST", path, tokens.Ann!, { button: "late", values: { guests: 2 } })).status,
    ).toBe(409);

    const items = await timeline();
    const press = items.find((item) => item.type === "user" && item.press !== undefined);
    expect(press).toMatchObject({
      type: "user",
      author: { id: "bo" },
      text: 'Pressed "18:00" on "Pick a time"\nGuests: 4\nNote: By the window',
      press: { callId: part.callId, button: "early" },
    });
    expect((await cardPart()).pressed).toEqual({
      button: "early",
      by: { id: "bo", displayName: "Bo" },
    });
  });

  it("keeps a card in a private answer to who it was for", async () => {
    await ask("Ann", "Book me a table", { private: true });
    const part = await cardPart();
    const path = `/rooms/trip/ui/${part.callId}`;
    expect((await call("POST", path, tokens.Bo!, { button: "none" })).status).toBe(404);
    expect((await call("POST", path, tokens.Ann!, { button: "none" })).status).toBe(202);
    await idle();
    const press = (await timeline()).find((item) => item.type === "user" && item.press);
    expect(press).toMatchObject({ text: 'Pressed "Neither" on "Pick a time"' });
    expect(press).toHaveProperty("privateTo", { id: "ann", displayName: "Ann" });
  });

  it("leaves out a card that isn't valid", async () => {
    const shown = projectTimeline([
      {
        id: 1,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "c1", name: "x", arguments: {} }],
            stopReason: "toolUse",
            timestamp: 1,
          },
        ],
      },
      {
        id: 2,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "x",
            content: [{ type: "text", text: "ok" }],
            details: { ui: { v: 1, blocks: [{ type: "iframe", src: "https://x" }] }, keep: 1 },
            isError: false,
            timestamp: 2,
          },
        ],
      },
    ] as unknown as EntryRecord[]);
    const answer = shown[0] as Extract<TimelineItem, { type: "answer" }>;
    expect((answer.parts[0] as ToolPart).details).toEqual({ keep: 1 });
  });
});
