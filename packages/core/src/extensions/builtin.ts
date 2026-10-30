import type { Change } from "../changes.ts";
import type { Autonomy, Style } from "../config.ts";
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
import { UNTRUSTED_RULE } from "../privacy/untrusted.ts";
import type { UiPresses } from "../ui/presses.ts";
import { createUiTools } from "../ui/tools.ts";
import { BUILTIN_NAME } from "./define.ts";

export type BuiltinOptions = {
  readonly displayName: string;
  readonly timeZone: string;
  readonly now: () => number;
  /** Resolved at call time: the extension is installed before the assistant opens. */
  readonly nudges: () => Nudges;
  /** Cards in the chat, for `update_ui`; resolved at call time like `nudges`. */
  readonly ui?: () => UiPresses;
  /** Told about what the tools change beyond the room, such as a player's own memory. */
  readonly changed?: (change: Change) => void;
  /** The turn a conversation is in, for what shows only in private turns. */
  readonly turn: (conversationId: ConversationId, context: Context) => Promise<Turn>;
  /** An installed extension's description, looked up at render time, so it follows a reload. */
  readonly describe?: (extension: string) => string | undefined;
  /** Whether the vault can still put a placeholder's value back, looked up at render time. */
  readonly known: (placeholder: string) => boolean;
  /** How much it says; default "concise". */
  readonly style?: Style;
  /** How much it decides itself; default "balanced". */
  readonly autonomy?: Autonomy;
};

const STYLES: Record<Style, string> = {
  concise:
    "Answer in as few words as do the job: the answer first, no preamble, no recap of the steps " +
    "you took, no offer of more help at the end. Say how you got it only when asked, or when it " +
    "changes how far to trust it.",
  balanced:
    "Answer first, then the context that helps act on it. Keep it short: add detail only where it " +
    "changes what someone would do. No preamble, and no offer of more help at the end.",
  detailed:
    "Answer first, then explain: the reasons, sources, trade-offs and what to watch for. Use " +
    "headings or lists when they make a long answer easier to scan.",
};

const AUTONOMY: Record<Autonomy, string> = {
  cautious:
    "Look things up without asking. Before work that takes many steps, changes something, or " +
    "costs notable time or money, say in one line what you'll do and wait for a go-ahead.",
  balanced:
    "Ask only when a wrong guess is costly or hard to undo, or when the request can mean quite " +
    "different things. Otherwise make the call yourself, and name an assumption in a few words " +
    "when you make one.",
  independent:
    "Make the calls yourself, also on bigger or unclear tasks: take the likeliest meaning, say it " +
    "in a line, and finish the job. Ask only for what you can't go on without and only the person " +
    "knows, such as a choice between their own plans.",
};

/**
 * What every level shares: do the task rather than offer ways to, and get past a failed tool
 * without asking. Approvals the tools ask for are the person's at every level.
 */
export function describeAutonomy(autonomy: Autonomy): string {
  return [
    "Do what is asked; don't describe how you could. When a tool fails or a source is down, try " +
      "the next way yourself, such as another tool, a web search or the browser, and mention in a " +
      "few words what you used. Give one answer, not a menu of options: when choices are close, " +
      "pick one and name the other in a line.",
    AUTONOMY[autonomy],
    "Approvals the tools ask for, such as before buying, booking or sending, still apply: those " +
      "are the person's call.",
  ].join(" ");
}

/**
 * The always-on `nudge` extension: who the assistant is, who is in the room, the personal details
 * of whose room or private turn it is, what it remembers there, what time it is, how to treat
 * untrusted data (ADR 20), the nudge timer with its tools, and cards in the chat (ADR 27).
 */
export function createBuiltinExtension(options: BuiltinOptions): Extension {
  return defineExtension({
    name: BUILTIN_NAME,
    tasks: [NudgeTimer],
    tools: [
      ...createNudgeTools(options),
      ...createMemoryTools(options.now, options.changed),
      ...createUiTools(options.ui),
    ],
    sections: [
      section(
        "identity",
        () =>
          `You are ${options.displayName}, a personal assistant. ` +
          `Several people may share a conversation; each message starts with the name of who wrote it and the time they sent it.`,
        { tag: false },
      ),
      // Static, so they come before what changes, for prompt caching.
      section("style", () => STYLES[options.style ?? "concise"]),
      section("autonomy", () => describeAutonomy(options.autonomy ?? "balanced")),
      section("untrusted", () => UNTRUSTED_RULE),
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
