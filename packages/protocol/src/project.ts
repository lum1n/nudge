import { cardOf } from "@nudge/core/ui-card";
import {
  addressOf,
  type Approval as CoreApproval,
  type ApprovalEntryData,
  type ConversationView,
  type EntryRecord,
  type FactPerson,
  type FireEntryData,
  type InboxItem,
  type InboxState,
  type LiveState,
  type MessageEntryData,
  type Player as CorePlayer,
  type Room as CoreRoom,
  type RoomFact as CoreRoomFact,
  type ScheduledNudge,
  type ToolSlot,
} from "@nudge/core";
import type {
  Appearance,
  Approval,
  Attachment,
  Fact,
  RoomListNudge,
  RoomListEntry,
  RoomListView,
  Part,
  Player,
  QueuedMessage,
  Room,
  RoomNudge,
  RoomView,
  Status,
  TimelineItem,
  ToolPart,
} from "./schema.ts";

export { Viewer } from "./viewer.ts";

/**
 * How a host turns its rooms into protocol views. This is the one place that reads pi-durable's
 * shapes; clients only see what comes out.
 */

// Entry kinds of @nudge/core, kept here so this module needs no runtime import of it. A test
// checks them against core's.
export const MESSAGE_ENTRY = "nudge.message";
export const FIRE_ENTRY = "nudge.fire";
export const APPROVAL_ENTRY = "nudge.approval";

/** Entries that are a timeline item each; the assistant entries between two of them are an answer. */
const ITEM_ENTRIES: ReadonlySet<string> = new Set([
  MESSAGE_ENTRY,
  "pi.user",
  FIRE_ENTRY,
  APPROVAL_ENTRY,
  "pi.compaction",
  "pi.reset",
]);

/** Items a room view holds at most; older ones come from `GET /rooms/<id>/timeline`. */
export const TIMELINE_LIMIT = 100;

/** Tool results and details longer than this many characters are cut. */
export const TOOL_OUTPUT_LIMIT = 8 * 1024;

/** Decided approvals a room view keeps, besides the pending ones. */
const DECIDED_APPROVALS = 10;

export type RoomSources = {
  readonly room: Room;
  readonly view: ConversationView;
  /** Newest first, as `Approvals.list` gives them. */
  readonly approvals: readonly CoreApproval[];
  readonly memory: readonly CoreRoomFact[];
  readonly nudges: readonly ScheduledNudge[];
  /** Ids of the members whose location the model may know in the room. */
  readonly sharingLocation?: readonly string[];
};

type Kept<T> = { readonly sources: readonly unknown[]; readonly value: T };

/**
 * One room's view, projected again for each new set of sources. Parts whose sources are the same
 * objects as last time come back as the same objects, so `diff` against the previous view skips
 * them without a look inside. Use one projector per room.
 */
export class RoomProjector {
  private items = new Map<string, Kept<TimelineItem>>();
  private parts = new Map<string, Kept<unknown>>();

  constructor(private readonly limit = TIMELINE_LIMIT) {}

  project(sources: RoomSources): RoomView {
    const live = sources.view.docs["pi.live"] as LiveState | undefined;
    const inbox = sources.view.docs["pi.inbox"] as InboxState | undefined;
    const next = new Map<string, Kept<TimelineItem>>();
    const all = items(sources.view.entries, live?.run === undefined ? undefined : live, {
      keep: (id, itemSources, build) => {
        const value = reuse(this.items.get(id), itemSources, build);
        next.set(id, { sources: itemSources, value });
        return value;
      },
    });
    this.items = next;

    const first = sources.view.entries[0]?.kind;
    const status = statusOf(live);
    return {
      room: sources.room,
      timeline: all.length > this.limit ? all.slice(-this.limit) : all,
      hasEarlier: all.length > this.limit || first === "pi.compaction" || first === "pi.reset",
      live: { running: live?.run !== undefined, ...(status === undefined ? {} : { status }) },
      queue: this.part("queue", [inbox?.items], () =>
        (inbox?.items ?? []).flatMap((item) => queued(item)),
      ),
      approvals: this.part("approvals", [sources.approvals], () => approvals(sources.approvals)),
      memory: this.part("memory", [sources.memory], () => sources.memory.map(toFact)),
      nudges: this.part("nudges", [sources.nudges], () =>
        [...sources.nudges].sort((a, b) => a.fireAt - b.fireAt).map(toRoomNudge),
      ),
      ...(sources.sharingLocation === undefined || sources.sharingLocation.length === 0
        ? {}
        : {
            sharingLocation: this.part(
              "sharingLocation",
              [sources.sharingLocation, sources.room],
              () =>
                sources.room.members.filter((member) =>
                  sources.sharingLocation!.includes(member.id),
                ),
            ),
          }),
    };
  }

  private part<T>(name: string, sources: readonly unknown[], build: () => T): T {
    const value = reuse(this.parts.get(name) as Kept<T> | undefined, sources, build);
    this.parts.set(name, { sources, value });
    return value;
  }
}

function reuse<T>(before: Kept<T> | undefined, sources: readonly unknown[], build: () => T): T {
  return before !== undefined && sameItems(before.sources, sources) ? before.value : build();
}

/**
 * Timeline items for a run of finished entries, oldest first, such as a page of history. `after`
 * names the item before the first entry, so an answer there gets the id it has in the room view.
 */
export function projectTimeline(
  entries: readonly EntryRecord[],
  options: {
    readonly after?: string;
    /** The entry `after` names, so an answer to it is as private as it is. */
    readonly afterEntry?: EntryRecord;
  } = {},
): TimelineItem[] {
  return items(entries, undefined, { after: options.after, afterEntry: options.afterEntry });
}

/**
 * The id of the oldest entry the room view of `view` shows, or undefined when it shows none. History
 * pages (`TimelinePager`) start below it, so they hold only what the view doesn't.
 */
export function windowStart(view: ConversationView, limit = TIMELINE_LIMIT): number | undefined {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const starts: number[] = [];
  const all = items(view.entries, live?.run === undefined ? undefined : live, {
    start: (entryId) => starts.push(entryId),
  });
  if (all.length <= limit) return view.entries[0]?.id;
  // Only an answer in flight with nothing written yet has no entry, and it is always the last item.
  return starts[all.length - limit];
}

/**
 * One page of history, from entries read newest first below the room view's window or the previous
 * page. A page ends just above an entry that is an item of its own, so its oldest answer gets the id
 * it would have in a room view (`answer:<the item before>`), and the next page starts at that entry.
 */
export class TimelinePager {
  private readonly held: EntryRecord[] = [];
  private count = 0;
  private inAnswer = false;
  private next: EntryRecord | undefined;

  /** A page holds at least `limit` items, or all that are left, and at most one more. */
  constructor(private readonly limit: number) {}

  /** Takes the next older entry. False when the page is full: `entry` is not on it, stop reading. */
  add(entry: EntryRecord): boolean {
    if (this.next !== undefined) return false;
    if (entry.kind === "pi.assistant") {
      if (!this.inAnswer) this.count++;
      this.inAnswer = true;
    } else if (ITEM_ENTRIES.has(entry.kind)) {
      if (this.count >= this.limit) {
        this.next = entry;
        return false;
      }
      this.count++;
      this.inAnswer = false;
    }
    this.held.push(entry);
    return true;
  }

  /**
   * The page's items, oldest first, and the id the next page starts below (exclusive); no `before`
   * when the page reaches the start of the room.
   */
  page(): { readonly items: TimelineItem[]; readonly before?: number } {
    const entries = [...this.held].reverse();
    if (this.next === undefined) return { items: projectTimeline(entries) };
    return {
      items: projectTimeline(entries, { after: `entry:${this.next.id}`, afterEntry: this.next }),
      before: this.next.id + 1,
    };
  }
}

function items(
  entries: readonly EntryRecord[],
  live: LiveState | undefined,
  options: {
    readonly after?: string | undefined;
    readonly afterEntry?: EntryRecord | undefined;
    readonly keep?: (
      id: string,
      sources: readonly unknown[],
      build: () => TimelineItem,
    ) => TimelineItem;
    /** Told the first entry of each item that has entries, in order. */
    readonly start?: (entryId: number) => void;
  },
): TimelineItem[] {
  const keep = options.keep ?? ((_id, _sources, build) => build());
  const results = new Map<string, EntryRecord>();
  // The latest press on each card, by tool call id.
  const presses = new Map<string, EntryRecord>();
  for (const entry of entries)
    if (entry.kind === "pi.tool-result") {
      const id = toolResult(entry)?.toolCallId;
      if (id !== undefined) results.set(id, entry);
    } else if (entry.kind === MESSAGE_ENTRY) {
      const press = (entry.data as MessageEntryData).press;
      if (press !== undefined) presses.set(press.callId, entry);
    }

  const timeline: TimelineItem[] = [];
  // An answer collects assistant entries until the next message. It is named after the item
  // before it, so the answer in flight keeps its id once its entry is written.
  let answer: EntryRecord[] = [];
  let after = options.after ?? "start";
  // The item before the answer: when it is private to someone, so is its answer.
  let before: EntryRecord | undefined = options.afterEntry;
  const endAnswer = (live?: LiveState) => {
    const generated = live?.generation?.message as AssistantMessage | undefined;
    if (answer.length === 0 && generated === undefined && !(live?.tools?.length ?? 0)) return;
    const answerEntries = answer;
    const calls = answerEntries.flatMap((entry) => toolCalls(entry));
    const callResults = calls.map((call) => results.get(call.id));
    const callPresses = calls.map((call) => presses.get(call.id));
    const sources = [
      before,
      ...answerEntries,
      ...callResults,
      ...callPresses,
      generated,
      live?.tools,
      live !== undefined,
    ];
    const id = `answer:${after}`;
    const owner = before === undefined ? undefined : privateToOf(before);
    const prompt = before === undefined ? undefined : promptedBy(before);
    timeline.push(
      keep(id, sources, () => {
        const built = buildAnswer(id, answerEntries, results, presses, live, generated);
        return {
          ...built,
          ...(prompt === undefined ? {} : { promptedBy: prompt }),
          ...(owner === undefined ? {} : { privateTo: owner }),
        };
      }),
    );
    if (answerEntries[0] !== undefined) options.start?.(answerEntries[0].id);
    answer = [];
  };

  for (const entry of entries) {
    if (entry.kind === "pi.assistant") answer.push(entry);
    else if (ITEM_ENTRIES.has(entry.kind)) {
      endAnswer();
      const id = `entry:${entry.id}`;
      timeline.push(keep(id, [entry], () => entryItem(id, entry)));
      options.start?.(entry.id);
      after = id;
      before = entry;
    }
    // Anything else is a system prompt, a tool result (shown with its call) or bookkeeping.
  }
  endAnswer(live);
  return timeline;
}

type Message = NonNullable<EntryRecord["model"]>[number];
type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ToolResultMessage = Extract<Message, { role: "toolResult" }>;
type Content = AssistantMessage["content"][number];

function entryItem(id: string, entry: EntryRecord): TimelineItem {
  switch (entry.kind) {
    case MESSAGE_ENTRY: {
      const data = entry.data as MessageEntryData;
      return {
        type: "user",
        id,
        text: data.text,
        author: { id: data.playerId, displayName: data.displayName },
        sentAt: data.sentAt,
        ...(data.clientId === undefined ? {} : { clientId: data.clientId }),
        ...(data.requestId === undefined ? {} : { requestId: data.requestId }),
        ...privately(entry),
        ...attachmentsOf(data),
        ...(data.press === undefined
          ? {}
          : { press: { callId: data.press.callId, button: data.press.button } }),
      };
    }
    case FIRE_ENTRY: {
      const data = entry.data as FireEntryData;
      return { type: "nudge", id, text: data.message, firedAt: data.fireAt, ...privately(entry) };
    }
    case APPROVAL_ENTRY: {
      const data = entry.data as ApprovalEntryData;
      return {
        type: "approval",
        id,
        approvalId: data.id,
        summary: data.summary,
        status: data.status,
        ...(data.decidedBy === undefined ? {} : { decidedBy: data.decidedBy }),
        ...privately(entry),
      };
    }
    case "pi.compaction":
    case "pi.reset":
      return { type: "marker", id, kind: entry.kind === "pi.reset" ? "reset" : "compacted" };
    default: {
      const message = entry.model?.find((m) => m.role === "user");
      return { type: "user", id, text: message === undefined ? "" : text(message.content) };
    }
  }
}

/** Who a message, fired nudge or approval outcome is private to, as a player. */
function privateToOf(entry: {
  readonly kind?: string;
  readonly data?: unknown;
}): Player | undefined {
  if (entry.kind === MESSAGE_ENTRY) {
    const data = entry.data as MessageEntryData;
    return data.private === true ? { id: data.playerId, displayName: data.displayName } : undefined;
  }
  if (entry.kind === FIRE_ENTRY || entry.kind === APPROVAL_ENTRY) {
    const owner = (entry.data as FireEntryData | ApprovalEntryData).privateTo;
    return owner === undefined ? undefined : { id: owner.playerId, displayName: owner.displayName };
  }
  return undefined;
}

/** A message's attachments, as the protocol shows them. */
function attachmentsOf(data: MessageEntryData): { attachments?: Attachment[] } {
  if (data.attachments === undefined || data.attachments.length === 0) return {};
  return {
    attachments: data.attachments.map(({ id, name, mime, size, kind }) => ({
      id,
      name,
      mime,
      size,
      kind,
    })),
  };
}

/** What an answer to this entry answers, when it isn't a message: a fired nudge or a watch. */
function promptedBy(entry: EntryRecord): "nudge" | "watch" | undefined {
  if (entry.kind !== FIRE_ENTRY) return undefined;
  return (entry.data as FireEntryData).source === "watch" ? "watch" : "nudge";
}

function privately(entry: { readonly kind?: string; readonly data?: unknown }): {
  privateTo?: Player;
} {
  const owner = privateToOf(entry);
  return owner === undefined ? {} : { privateTo: owner };
}

function buildAnswer(
  id: string,
  entries: readonly EntryRecord[],
  results: ReadonlyMap<string, EntryRecord>,
  presses: ReadonlyMap<string, EntryRecord>,
  live: LiveState | undefined,
  generated: AssistantMessage | undefined,
): TimelineItem {
  const slots = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]));
  const parts: Part[] = [];
  let first: AssistantMessage | undefined;
  let last: AssistantMessage | undefined;
  for (const entry of entries)
    for (const message of entry.model ?? [])
      if (message.role === "assistant") {
        first ??= message;
        last = message;
        for (const content of message.content) {
          const part = toPart(content, results, presses, slots);
          if (part !== undefined) parts.push(part);
        }
      }
  if (generated !== undefined)
    for (const content of generated.content) {
      const part = toPart(content, results, presses, slots);
      if (part !== undefined) parts.push(part);
    }
  // When it started: its first model response; a live one's first token, before that's saved.
  const startedAt = (first ?? generated)?.timestamp;
  const base = { type: "answer" as const, id, ...(startedAt === undefined ? {} : { startedAt }) };
  if (live !== undefined) return { ...base, status: "running", parts };
  if (last?.stopReason === "aborted") return { ...base, status: "stopped", parts };
  if (last?.stopReason === "error")
    return {
      ...base,
      status: "failed",
      ...(last.errorMessage === undefined ? {} : { error: last.errorMessage }),
      parts,
    };
  return { ...base, status: "done", parts };
}

function toPart(
  content: Content,
  results: ReadonlyMap<string, EntryRecord>,
  presses: ReadonlyMap<string, EntryRecord>,
  slots: ReadonlyMap<string, ToolSlot>,
): Part | undefined {
  switch (content.type) {
    case "text":
      return content.text === "" ? undefined : { type: "text", text: content.text };
    case "thinking":
      return content.thinking === "" ? undefined : { type: "reasoning", text: content.thinking };
    case "toolCall": {
      const entry = results.get(content.id);
      const result = entry === undefined ? undefined : toolResult(entry);
      const slot = slots.get(content.id);
      const part: ToolPart = {
        type: "tool",
        callId: content.id,
        name: content.name,
        args: content.arguments,
        status: result !== undefined ? "done" : (slot?.status ?? "pending"),
      };
      if (result === undefined)
        return slot?.output === undefined ? part : { ...part, output: slot.output };
      const shown = {
        ...part,
        ...cut(text(result.content), result.details),
        isError: result.isError,
      };
      const press = presses.get(content.id)?.data as MessageEntryData | undefined;
      return press?.press === undefined || cardOf(shown.details) === undefined
        ? shown
        : {
            ...shown,
            pressed: {
              button: press.press.button,
              by: { id: press.playerId, displayName: press.displayName },
            },
          };
    }
    default:
      return undefined;
  }
}

/** A tool's result and details, cut down to what a view carries; an invalid card left out. */
function cut(result: string, given: unknown): Partial<ToolPart> {
  const details = withValidCard(given);
  const long = result.length > TOOL_OUTPUT_LIMIT;
  const keepDetails =
    details !== undefined && (JSON.stringify(details)?.length ?? 0) <= TOOL_OUTPUT_LIMIT;
  return {
    result: long ? result.slice(0, TOOL_OUTPUT_LIMIT) : result,
    ...(keepDetails ? { details } : {}),
    ...(long || (details !== undefined && !keepDetails) ? { truncated: true } : {}),
  };
}

/** Details without their `ui` when it isn't a card clients can draw. */
function withValidCard(details: unknown): unknown {
  if (typeof details !== "object" || details === null || !("ui" in details)) return details;
  if (cardOf(details) !== undefined) return details;
  const { ui: _, ...rest } = details as Record<string, unknown>;
  return rest;
}

function queued(item: InboxItem): QueuedMessage[] {
  if (item.mode === "write") return [];
  const entry = item.entry as { kind?: string; data?: unknown } | undefined;
  const base = { id: item.id, mode: item.mode };
  if (entry?.kind === MESSAGE_ENTRY) {
    const data = entry.data as MessageEntryData;
    return [
      {
        ...base,
        text: data.text,
        author: { id: data.playerId, displayName: data.displayName },
        ...(data.clientId === undefined ? {} : { clientId: data.clientId }),
        ...(data.requestId === undefined ? {} : { requestId: data.requestId }),
        nudge: false,
        ...privately(entry),
        ...attachmentsOf(data),
      },
    ];
  }
  if (entry?.kind === FIRE_ENTRY)
    return [
      { ...base, text: (entry.data as FireEntryData).message, nudge: true, ...privately(entry) },
    ];
  if (entry?.kind === APPROVAL_ENTRY) {
    const data = entry.data as ApprovalEntryData;
    return [
      {
        ...base,
        text: `${data.id} ${data.status}: ${data.summary}`,
        nudge: true,
        ...privately(entry),
      },
    ];
  }
  return [
    {
      ...base,
      text: text(item.content as Extract<Message, { role: "user" }>["content"]),
      nudge: false,
    },
  ];
}

function statusOf(live: LiveState | undefined): Status | undefined {
  const generation = live?.generation;
  if (generation?.retry !== undefined)
    return {
      kind: "retrying",
      attempt: generation.attempt,
      at: generation.retry.at,
      error: generation.retry.error,
    };
  if (live?.compactions?.some((compaction) => compaction.blocking)) return { kind: "compacting" };
  if (live?.compactionFailure !== undefined)
    return { kind: "compaction-failed", error: live.compactionFailure.error };
  return undefined;
}

function approvals(list: readonly CoreApproval[]): Approval[] {
  let decided = 0;
  return list
    .filter((approval) => approval.status === "pending" || decided++ < DECIDED_APPROVALS)
    .map(toApproval);
}

// Core's records as protocol shapes, for hosts building views.

export function toPlayer(player: Pick<CorePlayer, "id" | "displayName" | "home">): Player {
  return {
    id: player.id,
    displayName: player.displayName,
    ...(player.home === undefined ? {} : { address: addressOf(player.home) }),
  };
}

/** `players` looks up members by id; members it can't find are left out. */
export function toRoom(room: CoreRoom, players: (id: string) => CorePlayer | undefined): Room {
  return {
    id: room.id,
    kind: room.kind,
    name: room.name,
    members: room.members.flatMap((id) => {
      const player = players(id);
      return player === undefined ? [] : [toPlayer(player)];
    }),
    ...(room.imagesToModel === true ? { imagesToModel: true } : {}),
  };
}

export function toApproval(approval: CoreApproval): Approval {
  return {
    id: approval.id,
    summary: approval.summary,
    status: approval.status,
    requestedAt: approval.requestedAt,
    ...(approval.decidedBy === undefined
      ? {}
      : {
          decidedBy: {
            id: approval.decidedBy.playerId,
            displayName: approval.decidedBy.displayName,
          },
        }),
    ...(approval.decidedAt === undefined ? {} : { decidedAt: approval.decidedAt }),
    ...(approval.result === undefined ? {} : { result: approval.result }),
    ...(approval.privateTo === undefined ? {} : { privateTo: player(approval.privateTo) }),
    ...(approval.adminOnly === true ? { adminOnly: true } : {}),
    ...(approval.inputs === undefined
      ? {}
      : { inputs: approval.inputs.map((input) => ({ ...input })) }),
    ...(approval.clientAction === undefined ? {} : { clientAction: { ...approval.clientAction } }),
  };
}

function player(owner: { readonly playerId: string; readonly displayName: string }): Player {
  return { id: owner.playerId, displayName: owner.displayName };
}

export function toFact(fact: CoreRoomFact): Fact {
  const person = (who: FactPerson) => ({ id: who.playerId, displayName: who.displayName });
  return {
    id: fact.id,
    text: fact.text,
    createdAt: fact.createdAt,
    ...(fact.by === undefined ? {} : { by: person(fact.by) }),
    ...(fact.owner === undefined ? {} : { owner: person(fact.owner) }),
    ...(fact.privateTo === undefined ? {} : { privateTo: person(fact.privateTo) }),
  };
}

export function toRoomNudge(nudge: ScheduledNudge): RoomNudge {
  return {
    id: nudge.id,
    message: nudge.message,
    fireAt: nudge.fireAt,
    ...(nudge.every === undefined ? {} : { every: nudge.every }),
    ...(nudge.privateTo === undefined ? {} : { privateTo: player(nudge.privateTo) }),
  };
}

export function toRoomListNudge(nudge: ScheduledNudge): RoomListNudge {
  return { ...toRoomNudge(nudge), roomId: nudge.roomId };
}

export type RoomListSources = {
  readonly player: Player;
  readonly rooms: readonly RoomListEntry[];
  readonly nudges: readonly ScheduledNudge[];
  readonly appearance?: Appearance;
};

export function projectRoomList(sources: RoomListSources): RoomListView {
  return {
    player: sources.player,
    rooms: [...sources.rooms],
    nudges: [...sources.nudges].sort((a, b) => a.fireAt - b.fireAt).map(toRoomListNudge),
    ...(sources.appearance === undefined ? {} : { appearance: sources.appearance }),
  };
}

function toolCalls(entry: EntryRecord): { id: string }[] {
  return (entry.model ?? []).flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((content) => (content.type === "toolCall" ? [content] : []))
      : [],
  );
}

function toolResult(entry: EntryRecord): ToolResultMessage | undefined {
  return entry.model?.find(
    (message): message is ToolResultMessage => message.role === "toolResult",
  );
}

/** The text parts of a message's content, joined. */
function text(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
