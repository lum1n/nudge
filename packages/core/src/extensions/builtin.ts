import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { DirectoryDoc, type DirectoryState } from "../identity/directory.ts";
import type { Nudges } from "../nudges/nudges.ts";
import { NudgeTimer } from "../nudges/timer-task.ts";
import { createNudgeTools } from "../nudges/tools.ts";

export type BuiltinOptions = {
  readonly displayName: string;
  readonly timeZone: string;
  readonly now: () => number;
  /** Resolved at call time: the extension is installed before the assistant opens. */
  readonly nudges: () => Nudges;
};

/**
 * The always-on `nudge` extension: who the assistant is, who is in the room, what time it is, and
 * the nudge timer with its tools.
 */
export function createBuiltinExtension(options: BuiltinOptions): Extension {
  return defineExtension({
    name: "nudge",
    tasks: [NudgeTimer],
    tools: createNudgeTools(options),
    sections: [
      section(
        "identity",
        () =>
          `You are ${options.displayName}, a personal assistant. Be brief and concrete. ` +
          `Several people may share a conversation; each message starts with the name of who wrote it.`,
        { tag: false },
      ),
      section("members", async (input, context) =>
        describeRoom(await input.read.snapshot(DirectoryDoc, context), input.conversationId),
      ),
      // Rendered to the hour: a section that changes on every request defeats prompt caching.
      section("time", () => formatHour(options.now(), options.timeZone)),
    ],
  });
}

export function formatHour(now: number, timeZone: string): string {
  const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000);
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(hour);
  return `It is ${text} (${timeZone}), give or take an hour.`;
}

/** Who the conversation `conversationId` belongs to, or undefined before anyone has joined. */
export function describeRoom(
  directory: Readonly<DirectoryState> | undefined,
  conversationId: number,
): string | undefined {
  if (directory === undefined) return undefined;
  const room = Object.values(directory.rooms).find((r) => r.conversationId === conversationId);
  if (room === undefined) return undefined;
  const players = Object.values(directory.players);
  const names = (room.kind === "lobby" ? players.map((p) => p.id) : room.members)
    .map((id) => directory.players[id]?.displayName)
    .filter((name) => name !== undefined);
  if (names.length === 0) return undefined;
  if (room.kind === "personal")
    return `This is ${names[0]}'s personal conversation; only ${names[0]} reads it.`;
  return `People who can read this conversation: ${names.join(", ")}.`;
}
