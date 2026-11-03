import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/index.ts";
import type { MessageDraft } from "../src/host-api.ts";
import type { UiCard } from "../src/ui/card.ts";
import {
  UI_UPDATE_ENTRY,
  UiCardInvalid,
  UiCardNotFound,
  UiCardPressed,
  UiNotYours,
  UiPresses,
} from "../src/ui/presses.ts";

const context = BACKGROUND_CONTEXT;
const ann = { playerId: "ann", displayName: "Ann" };
const bo = { playerId: "bo", displayName: "Bo" };

const card = (extra: Partial<UiCard> = {}): UiCard => ({
  v: 1,
  title: "Times",
  buttons: [{ id: "go", label: "Go" }],
  ...extra,
});

type Entry = { kind: string; data?: unknown; model?: unknown[] };

const toolResult = (callId: string, shown: UiCard | unknown): Entry => ({
  kind: "pi.tool-result",
  model: [{ role: "toolResult", toolCallId: callId, details: { ui: shown } }],
});
const message = (by = ann, extra: object = {}): Entry => ({
  kind: "nudge.message",
  data: { playerId: by.playerId, displayName: by.displayName, ...extra },
});

/** Entries oldest first, as a test reads them; the fake serves them newest first, in pages. */
function setup(entries: Entry[], options: { pageSize?: number; failSubmit?: boolean } = {}) {
  const written: Entry[] = [];
  const submitted: MessageDraft[] = [];
  const state = { pressed: {} as Record<string, { by: string; button: string; at: number }> };
  const newestFirst = () => [...entries, ...written].reverse();
  const conversation = {
    entries: async (_filter: unknown, limit: number, cursor?: string) => {
      const all = newestFirst();
      const from = cursor === undefined ? 0 : Number(cursor);
      const size = Math.min(limit, options.pageSize ?? limit);
      const items = all.slice(from, from + size);
      return { items, next: from + size < all.length ? String(from + size) : undefined };
    },
    submit: async (input: { entry: Entry }) => {
      written.push(input.entry);
    },
  };
  const harness = {
    conversation: async () => conversation,
    commit: async (fn: (tx: unknown) => Promise<unknown>) => fn({ doc: async () => state }),
  };
  const rooms = {
    get: async (id: string) => (id === "room" ? { conversationId: "c1" } : undefined),
  };
  const presses = new UiPresses(
    harness as never,
    rooms as never,
    () => 42,
    async (_room, draft) => {
      if (options.failSubmit === true) throw new Error("boom");
      submitted.push(draft);
      return {} as never;
    },
  );
  return { presses, state, written, submitted };
}

describe("UiPresses", () => {
  it("finds the card across pages, and who the answer it is in was for", async () => {
    const { presses } = setup(
      [message(bo), toolResult("t1", card()), message(ann), { kind: "x" }],
      {
        pageSize: 1,
      },
    );
    expect(await presses.find("room", "t1", context)).toEqual({
      card: card(),
      askedBy: bo,
    });
    expect(await presses.find("room", "nope", context)).toBeUndefined();
    expect(await presses.find("elsewhere", "t1", context)).toBeUndefined();
  });

  it("gives a private answer's card to who asked, and a nudge's to who scheduled it", async () => {
    const privately = setup([message(ann, { private: true }), toolResult("t1", card())]);
    expect(await privately.presses.find("room", "t1", context)).toEqual({
      card: card(),
      privateTo: ann,
      askedBy: ann,
    });
    const fired = setup([
      { kind: "nudge.fire", data: { scheduledBy: bo } },
      toolResult("t1", card()),
    ]);
    expect(await fired.presses.find("room", "t1", context)).toEqual({
      card: card(),
      askedBy: bo,
    });
  });

  it("ignores a result whose card isn't valid", async () => {
    const { presses } = setup([message(), toolResult("t1", { v: 1, title: 3 })]);
    expect(await presses.find("room", "t1", context)).toBeUndefined();
  });

  it("draws the newest update, and ignores updates for other calls", async () => {
    const { presses } = setup([
      message(),
      toolResult("t1", card({ title: "First" })),
      { kind: UI_UPDATE_ENTRY, data: { callId: "t1", card: card({ title: "Second" }) } },
      { kind: UI_UPDATE_ENTRY, data: { callId: "t2", card: card({ title: "Other" }) } },
      { kind: UI_UPDATE_ENTRY, data: { callId: "t1", card: card({ title: "Third" }) } },
    ]);
    expect((await presses.find("room", "t1", context))?.card.title).toBe("Third");
  });

  it("posts a press as the presser's message, once", async () => {
    const { presses, state, submitted } = setup([message(), toolResult("t1", card())]);
    await presses.press("room", "t1", { by: bo, button: "go", requestId: "r1" }, context);
    expect(submitted).toEqual([
      {
        text: 'Pressed "Go" on "Times"',
        author: bo,
        requestId: "r1",
        press: { callId: "t1", button: "go" },
      },
    ]);
    expect(state.pressed.t1).toEqual({ by: "bo", button: "go", at: 42 });
    await expect(presses.press("room", "t1", { by: ann, button: "go" }, context)).rejects.toThrow(
      UiCardPressed,
    );
  });

  it("lets a card with once: false be pressed again", async () => {
    const { presses, submitted } = setup([message(), toolResult("t1", card({ once: false }))]);
    await presses.press("room", "t1", { by: ann, button: "go" }, context);
    await presses.press("room", "t1", { by: ann, button: "go" }, context);
    expect(submitted).toHaveLength(2);
  });

  it("refuses an unknown card, someone else's private card and a card for the asker only", async () => {
    const missing = setup([message(), toolResult("t1", card())]);
    await expect(
      missing.presses.press("room", "t2", { by: ann, button: "go" }, context),
    ).rejects.toThrow(UiCardNotFound);

    const privately = setup([message(ann, { private: true }), toolResult("t1", card())]);
    await expect(
      privately.presses.press("room", "t1", { by: bo, button: "go" }, context),
    ).rejects.toThrow(UiCardNotFound);
    await privately.presses.press("room", "t1", { by: ann, button: "go" }, context);
    expect(privately.submitted[0]?.private).toBe(true);

    const asker = setup([message(ann), toolResult("t1", card({ who: "asker" }))]);
    await expect(
      asker.presses.press("room", "t1", { by: bo, button: "go" }, context),
    ).rejects.toThrow(UiNotYours);
    await asker.presses.press("room", "t1", { by: ann, button: "go" }, context);
    expect(asker.submitted).toHaveLength(1);
  });

  it("doesn't mark a card pressed when the press is refused or can't be posted", async () => {
    const refused = setup([message(), toolResult("t1", card())]);
    await expect(
      refused.presses.press("room", "t1", { by: ann, button: "nope" }, context),
    ).rejects.toThrow(/No button/);
    expect(refused.state.pressed).toEqual({});

    const failing = setup([message(), toolResult("t1", card())], { failSubmit: true });
    await expect(
      failing.presses.press("room", "t1", { by: ann, button: "go" }, context),
    ).rejects.toThrow("boom");
    expect(failing.state.pressed).toEqual({});
  });

  it("puts back the earlier press when a repeatable card's press can't be posted", async () => {
    const { presses, state } = setup([message(), toolResult("t1", card({ once: false }))], {
      failSubmit: true,
    });
    const earlier = { by: "bo", button: "go", at: 1 };
    state.pressed.t1 = earlier;
    await expect(presses.press("room", "t1", { by: ann, button: "go" }, context)).rejects.toThrow(
      "boom",
    );
    expect(state.pressed.t1).toEqual(earlier);
  });

  it("updates a card, which makes its buttons work again", async () => {
    const { presses, state, written } = setup([message(), toolResult("t1", card())]);
    await presses.press("room", "t1", { by: ann, button: "go" }, context);
    await presses.update(
      "c1" as unknown as ConversationId,
      "t1",
      card({ title: "Later" }),
      context,
    );
    expect(state.pressed.t1).toBeUndefined();
    expect(written).toEqual([
      { kind: UI_UPDATE_ENTRY, data: { callId: "t1", card: card({ title: "Later" }) } },
    ]);
    expect((await presses.find("room", "t1", context))?.card.title).toBe("Later");
  });

  it("won't update a card that isn't there, isn't valid or is too big", async () => {
    const { presses, written } = setup([message(), toolResult("t1", card())]);
    const id = "c1" as unknown as ConversationId;
    await expect(presses.update(id, "t2", card(), context)).rejects.toThrow(UiCardNotFound);
    await expect(presses.update(id, "t1", { v: 1 } as UiCard, context)).rejects.toThrow(
      UiCardInvalid,
    );
    const big = card({
      blocks: [
        { type: "text", markdown: "x".repeat(4000) },
        { type: "text", markdown: "x".repeat(4000) },
      ],
    });
    await expect(presses.update(id, "t1", big, context)).rejects.toThrow(/over/);
    expect(written).toEqual([]);
  });
});
