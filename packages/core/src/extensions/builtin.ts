import type { Change } from "../changes.ts";
import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  defineExtension,
  type Extension,
  section,
} from "@earendil-works/pi-durable";
import { DirectoryDoc, type DirectoryState } from "../identity/directory.ts";
import { personalSection } from "../identity/personal.ts";
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
  /** An installed extension's description, looked up at render time, so it follows a reload. */
  readonly describe?: (extension: string) => string | undefined;
  /** Whether the vault can still put a placeholder's value back, looked up at render time. */
  readonly known: (placeholder: string) => boolean;
};

/**
 * The always-on `nudge` extension: who the assistant is, who is in the room, the personal details
 * of whose room or private turn it is, what it remembers there, what time it is, and the nudge
 * timer with its tools.
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
          `Several people may share a conversation; each message starts with the name of who wrote it and the time they sent it.`,
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
      personalSection(options.turn, options.known, options.timeZone),
      memorySection(options.turn),
      section("extensions", (input) =>
        describeExtensions(
          input.agent.extensions.map(({ name }) => name).filter((name) => name !== BUILTIN_NAME),
          options.describe,
        ),
      ),
      // The date only: a section that changes on every request defeats prompt caching. Messages
      // carry the minute they were sent.
      section("time", () => formatToday(options.now(), options.timeZone)),
    ],
  });
}

/**
 * The extensions on in a conversation, said outright. Providers without mid-conversation system
 * messages fold tool changes into one prompt, so the model can't tell that tools came after its
 * earlier replies, and repeats what those said it couldn't do.
 */
export function describeExtensions(
  names: readonly string[],
  describe: (extension: string) => string | undefined = () => undefined,
): string | undefined {
  if (names.length === 0) return undefined;
  const lines = names.map((name) => {
    const description = describe(name);
    return description === undefined ? `- ${name}` : `- ${name}: ${description}`;
  });
  return [
    "Extensions on in this conversation now:",
    ...lines,
    "They can be turned on during a conversation: go by this list and the tools you have now, " +
      "not by what earlier replies said you could do.",
  ].join("\n");
}

export function formatToday(now: number, timeZone: string): string {
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  return (
    `Today is ${today}, in the time zone ${timeZone}. Each message says the time it was sent; ` +
    `the latest one is the time now.`
  );
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
