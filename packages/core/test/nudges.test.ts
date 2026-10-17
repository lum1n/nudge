import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord, TaskId } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextFire } from "../src/nudges/schedule.ts";
import {
  createNudge,
  FIRE_ENTRY,
  type FireEntryData,
  LOBBY,
  type Nudge,
  type NudgeOptions,
  parseTime,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const HOUR = 3_600_000;

function setup(database: string, now?: () => number) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage("On it.")));
  const options: NudgeOptions = {
    database,
    models,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    timeZone: "Europe/Oslo",
    ...(now === undefined ? {} : { now }),
  };
  return { faux, options };
}

async function entries(nudge: Nudge, roomId: string): Promise<EntryRecord[]> {
  const conversation = await nudge.conversation(roomId, context);
  return [...(await conversation.entries({ order: "ascending" }, 500, undefined, context)).items];
}

async function fires(nudge: Nudge, roomId: string): Promise<FireEntryData[]> {
  return (await entries(nudge, roomId))
    .filter((entry) => entry.kind === FIRE_ENTRY)
    .map((entry) => entry.data as FireEntryData);
}

async function until(check: () => Promise<boolean>, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("times", () => {
  it("reads wall-clock times in the assistant's zone, and explicit offsets", () => {
    expect(parseTime("2026-10-13T14:30", "Europe/Oslo")).toBe(Date.UTC(2026, 9, 13, 12, 30));
    expect(parseTime("2026-12-01 09:00:15", "Europe/Oslo")).toBe(Date.UTC(2026, 11, 1, 8, 0, 15));
    expect(parseTime("2026-10-13T14:30Z", "Europe/Oslo")).toBe(Date.UTC(2026, 9, 13, 14, 30));
    expect(parseTime("2026-10-13T14:30+05:30", "Europe/Oslo")).toBe(Date.UTC(2026, 9, 13, 9, 0));
    expect(parseTime("2026-10-13T14:30", "America/New_York")).toBe(Date.UTC(2026, 9, 13, 18, 30));
    expect(parseTime("tomorrow at noon", "Europe/Oslo")).toBeUndefined();
    expect(parseTime("2026-13-01T10:00", "Europe/Oslo")).toBeUndefined();
  });

  it("skips repeats missed while the host was down", () => {
    expect(nextFire(1000, 100, 1050)).toBe(1100);
    expect(nextFire(1000, 100, 1100)).toBe(1200);
    expect(nextFire(1000, 100, 1555)).toBe(1600);
  });
});

describe("nudges", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fires once at its time, and the assistant answers it", async () => {
    const { options } = setup(":memory:");
    const nudge = await createNudge(options, context);
    const scheduled = await nudge.nudges.schedule(
      LOBBY,
      { message: "Stretch your legs", fireAt: Date.now() + 150 },
      context,
    );
    expect(await nudge.nudges.list(context)).toEqual([scheduled]);
    await until(async () => (await fires(nudge, LOBBY)).length === 1);
    await nudge.harness.waitForIdle(context);
    const log = await entries(nudge, LOBBY);
    const fire = log.findIndex((entry) => entry.kind === FIRE_ENTRY);
    expect(log[fire]?.data).toMatchObject({ nudgeId: scheduled.id, message: "Stretch your legs" });
    expect(log.slice(fire).some((entry) => entry.kind === "pi.assistant")).toBe(true);
    expect(await nudge.nudges.list(context)).toEqual([]);
    const task = await nudge.harness.getTask(Number(scheduled.id) as TaskId, context);
    expect(task?.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
    await nudge.close(context);
  });

  it("fires exactly once after a restart that came after its time", async () => {
    let shift = 0;
    const now = () => Date.now() + shift;
    const database = join(dir, "a.sqlite");
    const { options } = setup(database, now);
    const first = await createNudge(options, context);
    const room = await first.rooms.ensurePersonal(
      (await first.players.ensure("ann", "Ann", context)).id,
      context,
    );
    await first.nudges.schedule(
      room.id,
      { message: "Call the bank", fireAt: now() + HOUR },
      context,
    );
    await first.close(context);

    shift = 2 * HOUR;
    const second = await createNudge(options, context);
    await until(async () => (await fires(second, room.id)).length === 1);
    await second.harness.waitForIdle(context);
    expect(await second.nudges.list(context)).toEqual([]);
    await second.close(context);

    const third = await createNudge(options, context);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await third.harness.waitForIdle(context);
    expect(await fires(third, room.id)).toHaveLength(1);
    await third.close(context);
  });

  it("cancels a pending nudge", async () => {
    const { options } = setup(":memory:");
    const nudge = await createNudge(options, context);
    const scheduled = await nudge.nudges.schedule(
      LOBBY,
      { message: "Never mind", fireAt: Date.now() + HOUR },
      context,
    );
    expect(await nudge.nudges.cancel(scheduled.id, context)).toBe(true);
    expect(await nudge.nudges.list(context)).toEqual([]);
    const task = await nudge.harness.getTask(Number(scheduled.id) as TaskId, context);
    expect(task?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
    expect(await nudge.nudges.cancel(scheduled.id, context)).toBe(false);
    await nudge.close(context);
  });

  it("re-arms a repeating nudge after each fire", async () => {
    const { options } = setup(":memory:");
    const nudge = await createNudge(options, context);
    const start = Date.now();
    const scheduled = await nudge.nudges.schedule(
      LOBBY,
      { message: "Drink water", fireAt: start + 100, every: 150 },
      context,
    );
    await until(async () => (await fires(nudge, LOBBY)).length >= 2);
    const [pending] = await nudge.nudges.list(context);
    expect(pending?.id).toBe(scheduled.id);
    expect(pending!.fireAt).toBeGreaterThanOrEqual(start + 250);
    expect(await nudge.nudges.cancel(scheduled.id, context)).toBe(true);
    await nudge.harness.waitForIdle(context);
    const count = (await fires(nudge, LOBBY)).length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await fires(nudge, LOBBY)).toHaveLength(count);
    await nudge.close(context);
  });

  it("lets the model schedule, list and cancel the nudges of its room", async () => {
    const { faux, options } = setup(":memory:");
    const nudge = await createNudge(options, context);
    const ann = await nudge.players.ensure("ann", "Ann", context);
    const annsRoom = await nudge.rooms.ensurePersonal(ann.id, context);
    const author = { playerId: ann.id, displayName: ann.displayName };
    const outputs: string[] = [];
    const lastToolResult = (request: { messages: readonly { role: string }[] }) => {
      const message = request.messages.at(-1) as { role: string; content: { text?: string }[] };
      if (message.role === "toolResult") outputs.push(message.content[0]?.text ?? "");
    };
    const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1]) => () =>
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    const done = (request: Parameters<typeof lastToolResult>[0]) => {
      lastToolResult(request);
      return fauxAssistantMessage([fauxText("Done.")]);
    };

    faux.setResponses([
      toolCall("schedule_nudge", { message: "Water the plants", in_minutes: 30 }),
      done,
      toolCall("schedule_nudge", { message: "Too late", at: "2020-01-01T10:00" }),
      done,
    ]);
    await (await nudge.submit(annsRoom.id, { text: "Remind me", author }, context)).wait(context);
    await (await nudge.submit(annsRoom.id, { text: "And this", author }, context)).wait(context);
    const [scheduled] = await nudge.nudges.list(context);
    expect(scheduled).toMatchObject({ roomId: annsRoom.id, message: "Water the plants" });
    expect(outputs[0]).toContain(`Scheduled nudge ${scheduled!.id}:`);
    expect(outputs[1]).toBe("That time has passed.");

    // The lobby cannot see or cancel Ann's nudge.
    faux.setResponses([
      toolCall("list_nudges", {}),
      done,
      toolCall("cancel_nudge", { id: scheduled!.id }),
      done,
    ]);
    await (await nudge.submit(LOBBY, { text: "List", author }, context)).wait(context);
    await (await nudge.submit(LOBBY, { text: "Cancel", author }, context)).wait(context);
    expect(outputs.slice(2)).toEqual([
      "No nudges scheduled.",
      `No nudge ${scheduled!.id} in this conversation.`,
    ]);
    expect(await nudge.nudges.list(context)).toHaveLength(1);

    faux.setResponses([
      toolCall("list_nudges", {}),
      done,
      toolCall("cancel_nudge", { id: scheduled!.id }),
      done,
    ]);
    await (await nudge.submit(annsRoom.id, { text: "List", author }, context)).wait(context);
    await (await nudge.submit(annsRoom.id, { text: "Cancel", author }, context)).wait(context);
    expect(outputs[4]).toMatch(new RegExp(`^${scheduled!.id}: .* — Water the plants$`));
    expect(outputs[5]).toContain(`Cancelled nudge ${scheduled!.id}`);
    expect(await nudge.nudges.list(context)).toEqual([]);
    await nudge.close(context);
  });

  it("reads the times a player asks for in the time zone of their profile", async () => {
    const { faux, options } = setup(":memory:", () => Date.parse("2026-10-13T08:00:00Z"));
    const nudge = await createNudge(options, context);
    const ann = await nudge.players.ensure("ann", "Ann", context);
    await nudge.profiles.update(ann.id, { timeZone: "America/New_York" }, context);
    const annsRoom = await nudge.rooms.ensurePersonal(ann.id, context);
    const outputs: string[] = [];
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall("schedule_nudge", { message: "Call Bo", at: "2026-10-13T14:30" })],
          { stopReason: "toolUse" },
        ),
      (request) => {
        const message = request.messages.at(-1) as { content: { text?: string }[] };
        outputs.push(message.content[0]?.text ?? "");
        return fauxAssistantMessage([fauxText("Done.")]);
      },
    ]);
    const author = { playerId: ann.id, displayName: ann.displayName };
    await (await nudge.submit(annsRoom.id, { text: "Remind me", author }, context)).wait(context);
    const [scheduled] = await nudge.nudges.list(context);
    // 14:30 in New York is 18:30 UTC, not 12:30 as in the assistant's Oslo.
    expect(scheduled?.fireAt).toBe(Date.parse("2026-10-13T18:30:00Z"));
    expect(outputs[0]).toContain("14:30 America/New_York");
    await nudge.close(context);
  });
});
