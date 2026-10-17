import type { Change } from "../changes.ts";
import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  defineExtension,
  type Extension,
  section,
} from "@earendil-works/pi-durable";
import { DirectoryDoc, type DirectoryState } from "../identity/directory.ts";
import { ProfileDoc, type ProfileState } from "../identity/profiles.ts";
import { createMemoryTools, memorySection } from "../memory/memory.ts";
import type { Nudges } from "../nudges/nudges.ts";
import { NudgeTimer } from "../nudges/timer-task.ts";
import { createNudgeTools } from "../nudges/tools.ts";
import type { Turn } from "../privacy/turn.ts";
import { BUILTIN_NAME } from "./define.ts";

export type BuiltinOptions = {
  readonly displayName: string;
  readonly timeZone: string;
  readonly now: () => number;
  /** Resolved at call time: the extension is installed before the assistant opens. */
  readonly nudges: () => Nudges;
  /** Told about what the tools change beyond the room, such as a player's own memory. */
  readonly changed?: (change: Change) => void;
  /** The turn a conversation is in, for what shows only in private turns. */
  readonly turn: (conversationId: ConversationId, context: Context) => Promise<Turn>;
};

/**
 * The always-on `nudge` extension: who the assistant is, who is in the room, what it remembers there,
 * what time it is, and the nudge timer with its tools.
 */
export function createBuiltinExtension(options: BuiltinOptions): Extension {
  return defineExtension({
    name: BUILTIN_NAME,
    tasks: [NudgeTimer],
    tools: [...createNudgeTools(options), ...createMemoryTools(options.now, options.changed)],
    sections: [
      section(
        "identity",
        () =>
          `You are ${options.displayName}, a personal assistant. Be brief and concrete. ` +
          `Several people may share a conversation; each message starts with the name of who wrote it.`,
        { tag: false },
      ),
      section("members", async (input, context) => {
        const directory = await input.read.snapshot(DirectoryDoc, context);
        const profiles: Record<string, ProfileState> = {};
        for (const id of Object.keys(directory?.players ?? {})) {
          const profile = await input.read.snapshot(ProfileDoc, id, context);
          if (profile !== undefined) profiles[id] = profile;
        }
        return describeRoom(directory, input.conversationId, profiles);
      }),
      memorySection(options.turn),
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

/**
 * Who the conversation `conversationId` belongs to, with the time zones and languages their
 * profiles give, or undefined before anyone has joined.
 */
export function describeRoom(
  directory: Readonly<DirectoryState> | undefined,
  conversationId: number,
  profiles: Readonly<Record<string, ProfileState>> = {},
): string | undefined {
  if (directory === undefined) return undefined;
  const room = Object.values(directory.rooms).find((r) => r.conversationId === conversationId);
  if (room === undefined) return undefined;
  const players = (room.kind === "lobby" ? Object.keys(directory.players) : room.members)
    .map((id) => directory.players[id])
    .filter((player) => player !== undefined);
  if (players.length === 0) return undefined;
  const names = players.map((player) => player.displayName);
  const lines =
    room.kind === "personal"
      ? [`This is ${names[0]}'s personal conversation; only ${names[0]} reads it.`]
      : [`People who can read this conversation: ${names.join(", ")}.`];
  let languages = false;
  for (const player of players) {
    const { timeZone, language } = profiles[player.id] ?? {};
    const about = [
      ...(timeZone === undefined ? [] : [`time zone ${timeZone}`]),
      ...(language === undefined ? [] : [`speaks ${languageName(language)}`]),
    ];
    if (about.length > 0) lines.push(`${player.displayName}: ${about.join(", ")}.`);
    languages ||= language !== undefined;
  }
  if (languages) lines.push("Answer each person in their language.");
  return lines.join("\n");
}

function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
