import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Models,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BudgetReached,
  createNudge,
  FIRE_ENTRY,
  LOBBY,
  type Nudge,
  type NudgeOptions,
  type RoomEvent,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

/** `inner`, but every answer reports that it cost `usd`, as a priced model's would. */
function priced(inner: Models, usd: number): Models {
  const price = (event: AssistantMessageEvent): AssistantMessageEvent =>
    event.type === "done"
      ? {
          ...event,
          message: {
            ...event.message,
            usage: {
              ...event.message.usage,
              cost: { input: 0, output: usd, cacheRead: 0, cacheWrite: 0, total: usd },
            },
          },
        }
      : event;
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "streamSimple" || property === "stream")
        return (...args: unknown[]) => {
          const source = (
            target[property] as (...a: unknown[]) => AsyncIterable<AssistantMessageEvent>
          )(...args);
          const out = createAssistantMessageEventStream();
          void (async () => {
            for await (const event of source) out.push(price(event));
            out.end();
          })();
          return out;
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function until(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("spending", () => {
  let dir: string;
  let options: NudgeOptions;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-spend-"));
    const faux = fauxProvider();
    const inner = createModels();
    inner.setProvider(faux.provider);
    const models = priced(inner, 0.3);
    faux.setResponses(Array.from({ length: 30 }, () => () => fauxAssistantMessage("Done.")));
    options = {
      database: join(dir, "a.sqlite"),
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      timeZone: "Europe/Oslo",
      budget: { monthlyUsd: 1, perPlayerUsd: 0.5, warnAt: 0.8 },
      onReport: (error) => {
        throw error;
      },
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const say = async (nudge: Nudge, playerId: string, text: string) => {
    const player = (await nudge.players.get(playerId, context))!;
    const author = { playerId, displayName: player.displayName };
    const settled = await (await nudge.submit(LOBBY, { text, author }, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
  };

  it("books spend to the month, room and player, warns, then refuses, and survives a restart", async () => {
    let nudge = await createNudge(options, context);
    await nudge.players.invite("Ann", context); // the first player: an admin
    await nudge.players.invite("Bo", context);

    await say(nudge, "ann", "one");
    await until(() => nudge.spending.thisMonth().spend.total >= 0.3 - 1e-9);
    expect(nudge.spending.thisMonth().spend).toMatchObject({
      players: { ann: expect.closeTo(0.3) },
      rooms: { lobby: expect.closeTo(0.3) },
    });

    // Ann's second message passes her 80%: she hears about it in her own room, and that answer
    // passes the assistant's 80%, which the admins (Ann) hear about too.
    await say(nudge, "ann", "two");
    const fires = async () => {
      const room = await nudge.conversation("personal-ann", context).catch(() => undefined);
      if (room === undefined) return [];
      const { items } = await room.entries({ order: "ascending" }, 100, undefined, context);
      return items.filter((entry) => entry.kind === FIRE_ENTRY);
    };
    await until(async () => (await fires()).length === 2);
    await nudge.harness.waitForIdle(context);
    await until(() => nudge.spending.thisMonth().spend.total >= 1.2 - 1e-9);
    expect((await fires()).map((entry) => (entry.data as { message: string }).message)).toEqual([
      "Spent $0.600 of your $0.500 budget this month",
      "Spent $0.900 of the assistant's $1.00 budget this month",
    ]);
    const { spend } = nudge.spending.thisMonth();
    expect(spend.players).toEqual({ ann: expect.closeTo(0.6) });
    expect(spend.rooms).toEqual({
      lobby: expect.closeTo(0.6),
      "personal-ann": expect.closeTo(0.6),
    });

    // Past the assistant's budget: messages are refused, and so is anything else's model call.
    await expect(say(nudge, "bo", "three")).rejects.toThrow(BudgetReached);
    const events: RoomEvent[] = [];
    nudge.events.subscribe((event) => events.push(event));
    await nudge.nudges.schedule(LOBBY, { message: "stretch", fireAt: Date.now() - 1 }, context);
    await until(() => events.some((event) => event.type === "answer"));
    expect(events[0]).toMatchObject({ type: "answer", status: "failed" });
    expect(nudge.spending.thisMonth().spend.total).toBeCloseTo(1.2);

    // A restart books nothing twice.
    await nudge.close(context);
    nudge = await createNudge(options, context);
    expect(nudge.spending.thisMonth().spend.total).toBeCloseTo(1.2);
    expect(nudge.spending.refusalFor("bo")).toMatch(/used its budget for the month/);
    await nudge.close(context);
  });

  it("refuses a player past their own share while others go on", async () => {
    const nudge = await createNudge({ ...options, budget: { perPlayerUsd: 0.5 } }, context);
    await nudge.players.invite("Ann", context);
    await nudge.players.invite("Bo", context);
    await say(nudge, "ann", "one");
    await say(nudge, "ann", "two");
    await until(() => (nudge.spending.thisMonth().spend.players.ann ?? 0) >= 0.6 - 1e-9);
    await nudge.harness.waitForIdle(context);
    await expect(say(nudge, "ann", "three")).rejects.toThrow(/You have used your budget/);
    await say(nudge, "bo", "hi");
    await nudge.close(context);
  });

  it("tells the admins once when an assistant with no budget spends a lot, and refuses nothing", async () => {
    const nudge = await createNudge({ ...options, budget: { warnUsd: 0.5 } }, context);
    await nudge.players.invite("Ann", context); // the first player: an admin
    await nudge.players.invite("Bo", context);
    await say(nudge, "bo", "one");
    await say(nudge, "bo", "two");
    const fires = async () => {
      const room = await nudge.conversation("personal-ann", context).catch(() => undefined);
      if (room === undefined) return [];
      const { items } = await room.entries({ order: "ascending" }, 100, undefined, context);
      return items.filter((entry) => entry.kind === FIRE_ENTRY);
    };
    await until(async () => (await fires()).length === 1);
    await nudge.harness.waitForIdle(context);
    await say(nudge, "bo", "three");
    await nudge.harness.waitForIdle(context);
    expect((await fires()).map((entry) => (entry.data as { message: string }).message)).toEqual([
      "Spent $0.600 on models this month, with no monthly budget set",
    ]);
    expect(nudge.spending.refusalFor("bo")).toBeUndefined();
    await nudge.close(context);
  });
});
