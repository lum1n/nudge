import { readFile, writeFile } from "node:fs/promises";
import {
  BACKGROUND_CONTEXT,
  type ConversationView,
  createNudge,
  FIRE_ENTRY,
  type InboxState,
  MESSAGE_ENTRY,
  type Nudge,
} from "@nudge/core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@nudge/core/testing";
import { apply, diff, type Op } from "@nudge/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const context = BACKGROUND_CONTEXT;

/**
 * Room "trip" as pi-durable keeps it, after every commit of a short run, replayed by the
 * projector's tests (`packages/protocol/test/replay.ts`). `NUDGE_RECORD=1` writes it again from a
 * fresh run; the shape check below says when pi-durable changed the view under it.
 */
const FIXTURE = new URL("../../protocol/test/fixtures/conversation-view.json", import.meta.url);

/** The first view, then the ops from each view to the next. */
type Recording = {
  readonly me: string;
  readonly view: ConversationView;
  readonly frames: readonly (readonly Op[])[];
};

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** As JSON has it, without `pi.provider` (the provider's session id). */
function plain(view: ConversationView): ConversationView {
  const { "pi.provider": _, ...docs } = view.docs;
  return JSON.parse(JSON.stringify({ ...view, docs })) as ConversationView;
}

/**
 * Every path the views hold, with the type found there: array items merge, and transcript entries
 * are told apart by kind. Values differ between runs; this does not, unless the shape changed.
 */
function shape(views: readonly ConversationView[]): string[] {
  const paths = new Set<string>();
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      paths.add(`${path}: array`);
      for (const item of value) walk(item, `${path}[]`);
    } else if (value !== null && typeof value === "object") {
      paths.add(`${path}: object`);
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    } else paths.add(`${path}: ${value === null ? "null" : typeof value}`);
  };
  for (const view of views) {
    walk(view.conversation, "conversation");
    walk(view.docs, "docs");
    for (const entry of view.entries) walk(entry, `entries[${entry.kind}]`);
  }
  return [...paths].sort();
}

describe("conversation fixture", () => {
  let nudge: Nudge;

  beforeEach(async () => {
    const faux = fauxProvider({ tokensPerSecond: 200 });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking("Ann wants this kept."),
          fauxText("I'll note that."),
          fauxToolCall("remember", { fact: "Ann likes tea" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Noted: Ann likes tea."),
      fauxAssistantMessage("And Bo likes coffee."),
      fauxAssistantMessage("Time to put the kettle on!"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        settings: { progress: { partialIntervalMs: 20 } },
      },
      context,
    );
  });

  afterEach(async () => {
    await nudge.close(context);
  });

  it("still has the shape of a run today", async () => {
    const authors = [];
    for (const name of ["Ann", "Bo"]) {
      const { token } = await nudge.players.invite(name, context);
      const { player, clientId } = (await nudge.players.authenticate(token, context))!;
      authors.push({ playerId: player.id, displayName: player.displayName, clientId });
    }
    await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
    const [ann, bo] = authors;

    const watch = await nudge.watchRoom("trip", context);
    const revisions = [plain(watch.value)];
    watch.start(async (value) => {
      revisions.push(plain(value));
    });

    await nudge.submit(
      "trip",
      { text: "Remember that I like tea", author: ann!, requestId: "1" },
      context,
    );
    // Bo writes while the assistant is busy: the message waits in the inbox.
    await eventually(() => revisions.at(-1)?.docs["pi.live"]?.run !== undefined);
    await nudge.submit("trip", { text: "I like coffee", author: bo!, requestId: "1" }, context);
    await nudge.harness.waitForIdle(context);
    await nudge.nudges.schedule("trip", { message: "Kettle", fireAt: Date.now() + 50 }, context);
    await eventually(() => revisions.at(-1)!.entries.some((entry) => entry.kind === FIRE_ENTRY));
    await nudge.harness.waitForIdle(context);
    const last = plain(
      (await (await nudge.conversation("trip", context)).viewState(context)).value,
    );
    await eventually(() => JSON.stringify(revisions.at(-1)) === JSON.stringify(last));
    await watch.stop();

    const kinds = last.entries.map((entry) => entry.kind);
    expect(kinds.filter((kind) => kind === MESSAGE_ENTRY)).toHaveLength(2);
    expect(kinds).toContain("pi.tool-result");
    const queued = (view: ConversationView) =>
      (view.docs["pi.inbox"] as InboxState).items.length > 0;
    expect(revisions.some(queued)).toBe(true);

    if (process.env.NUDGE_RECORD === "1") {
      const frames = revisions.slice(1).map((view, n) => diff(revisions[n], view));
      await writeFile(
        FIXTURE,
        `${JSON.stringify({ me: "ann", view: revisions[0]!, frames } satisfies Recording)}\n`,
      );
    }

    const recording = JSON.parse(await readFile(FIXTURE, "utf8")) as Recording;
    const recorded = [recording.view];
    for (const ops of recording.frames) recorded.push(apply(recorded.at(-1)!, ops));
    expect(shape(recorded)).toEqual(shape(revisions));
  });
});
