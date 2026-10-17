import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type DocumentReader,
  defineDocFamily,
  defineTool,
  type Harness,
  type PromptSection,
  section,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Change } from "../changes.ts";
import { DirectoryDoc, type Room, roomOf } from "../identity/directory.ts";
import type { Rooms } from "../identity/rooms.ts";
import { keepsPlaceholders } from "../privacy/tool-values.ts";
import { currentTurn, type Turn } from "../privacy/turn.ts";

/** A person, as a fact names them. */
export type FactPerson = { playerId: string; displayName: string };

// Stored in a document, so plain JSON.
export type Fact = {
  /** `m1`, `m2`, … within its room; `p1`, `p2`, … within a player's own memory. */
  id: string;
  text: string;
  createdAt: number;
  /** Who remembered it; absent when the assistant did. */
  by?: FactPerson;
  /** Remembered in answer to something private: only this player sees it, and the model only in their private turns. */
  privateTo?: FactPerson;
};

/** A fact as a room shows it: the room's own, or one of a member's own facts. */
export type RoomFact = Fact & {
  /** Whose own memory it is from; absent for the room's facts. */
  owner?: FactPerson;
};

export type MemoryState = {
  /** Oldest first. */
  facts: Fact[];
  next: number;
};

export type PlayerMemoryState = MemoryState & {
  /** The player agreed to have these facts in every room they are in, not only their own. */
  shared: boolean;
};

/**
 * What the assistant keeps in mind in one room, keyed by room id. A room's memory is shown only in
 * that room, so it reaches exactly the people who could read it there: a personal room's memory
 * is its player's alone.
 */
export const MemoryDoc = defineDocFamily<MemoryState, null>({
  kind: "nudge.memory",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ facts: [], next: 1 }),
  // Stored whole on every change, so what was forgotten leaves no older revision (ADR 9).
  checkpointWhen: () => true,
});

/**
 * A player's own memory, keyed by player id: what they want the assistant to know about them
 * wherever they are. Shown in their personal room, and in their other rooms only once they share
 * it, since everyone there, and the model, then reads it.
 */
export const PlayerMemoryDoc = defineDocFamily<PlayerMemoryState, null>({
  kind: "nudge.player-memory",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ facts: [], next: 1, shared: false }),
  // Stored whole on every change, so what was forgotten leaves no older revision (ADR 9).
  checkpointWhen: () => true,
});

export const MAX_FACTS = 100;
export const MAX_FACT_LENGTH = 500;

export class MemoryFull extends Error {
  override name = "MemoryFull";
}

/** Adds a fact to a room's memory inside a commit. */
export async function addFact(
  tx: Tx,
  roomId: string,
  text: string,
  now: number,
  by?: FactPerson,
): Promise<Fact> {
  return push(await tx.doc(MemoryDoc, roomId, null), "m", text, now, by);
}

/** Adds a fact to a player's own memory inside a commit. */
export async function addPlayerFact(
  tx: Tx,
  playerId: string,
  text: string,
  now: number,
  by?: FactPerson,
): Promise<Fact> {
  return push(await tx.doc(PlayerMemoryDoc, playerId, null), "p", text, now, by);
}

function push(
  memory: MemoryState,
  prefix: string,
  text: string,
  now: number,
  by: FactPerson | undefined,
): Fact {
  const fact = text.trim().replace(/\s+/g, " ");
  if (fact === "") throw new Error("A fact needs text");
  if (fact.length > MAX_FACT_LENGTH)
    throw new Error(`A fact is at most ${MAX_FACT_LENGTH} characters`);
  if (memory.facts.length >= MAX_FACTS)
    throw new MemoryFull(`This memory holds ${MAX_FACTS} facts already; forget one first`);
  const { privateTo } = currentTurn();
  const added: Fact = {
    id: `${prefix}${memory.next}`,
    text: fact,
    createdAt: now,
    ...(by === undefined ? {} : { by: { ...by } }),
    ...(privateTo === undefined ? {} : { privateTo: { ...privateTo } }),
  };
  memory.next += 1;
  memory.facts.push(structuredClone(added));
  return added;
}

/** Drops a fact from a room's memory inside a commit. False when it has none with that id. */
export async function dropFact(tx: Tx, roomId: string, id: string): Promise<boolean> {
  return drop(await tx.doc(MemoryDoc, roomId, null), id);
}

/** Drops a fact from a player's own memory inside a commit. */
export async function dropPlayerFact(tx: Tx, playerId: string, id: string): Promise<boolean> {
  return drop(await tx.doc(PlayerMemoryDoc, playerId, null), id);
}

function drop(memory: MemoryState, id: string): boolean {
  const index = memory.facts.findIndex((fact) => fact.id === id);
  if (index < 0) return false;
  memory.facts.splice(index, 1);
  return true;
}

/** Each room's memory and each player's own, for hosts: list, add and forget what the model sees. */
export class Memory {
  constructor(
    private readonly harness: Harness,
    private readonly rooms: Rooms,
    private readonly now: () => number,
    private readonly changed: (change: Change) => void = () => {},
    /** Facts people add are kept with placeholders, like what the model remembers. */
    private readonly redact: (text: string) => string = (text) => text,
  ) {}

  /** The room's own facts. */
  async list(roomId: string, context: Context): Promise<Fact[]> {
    return readFacts(this.harness, roomId, context);
  }

  /** What the model sees in the room: its own facts, then the facts of members who share theirs. */
  async visible(roomId: string, context: Context): Promise<RoomFact[]> {
    const room = await this.rooms.get(roomId, context);
    if (room === undefined) return [];
    const own = await readFacts(this.harness, roomId, context);
    const shared = await sharedFacts(this.harness, room, context);
    return [
      ...own,
      ...shared.flatMap(({ owner, facts }) => facts.map((fact) => ({ ...fact, owner }))),
    ];
  }

  async remember(roomId: string, text: string, context: Context, by?: FactPerson): Promise<Fact> {
    if ((await this.rooms.get(roomId, context)) === undefined)
      throw new Error(`No room "${roomId}"`);
    const fact = await this.harness.commit(
      (tx) => addFact(tx, roomId, this.redact(text), this.now(), by),
      context,
    );
    this.changed({ kind: "memory", roomId });
    return fact;
  }

  /** False when the room has no fact with that id, or none `by` may see. */
  async forget(
    roomId: string,
    id: string,
    context: Context,
    by?: { readonly playerId: string },
  ): Promise<boolean> {
    const fact = (await readFacts(this.harness, roomId, context)).find((fact) => fact.id === id);
    if (fact === undefined) return false;
    if (by !== undefined && fact.privateTo !== undefined && fact.privateTo.playerId !== by.playerId)
      return false;
    const dropped = await this.harness.commit((tx) => dropFact(tx, roomId, id), context);
    if (dropped) this.changed({ kind: "memory", roomId });
    return dropped;
  }

  /** A player's own memory, and whether they share it with all their rooms. */
  async ofPlayer(playerId: string, context: Context): Promise<{ facts: Fact[]; shared: boolean }> {
    const memory = await this.harness.snapshot(PlayerMemoryDoc, playerId, context);
    return { facts: structuredClone(memory?.facts ?? []), shared: memory?.shared ?? false };
  }

  async rememberFor(
    playerId: string,
    text: string,
    context: Context,
    by?: FactPerson,
  ): Promise<Fact> {
    await this.knownPlayer(playerId, context);
    const fact = await this.harness.commit(
      (tx) => addPlayerFact(tx, playerId, this.redact(text), this.now(), by),
      context,
    );
    await this.playerChanged(playerId, context);
    return fact;
  }

  /** False when the player's own memory has no fact with that id. */
  async forgetFor(playerId: string, id: string, context: Context): Promise<boolean> {
    if (!(await this.ofPlayer(playerId, context)).facts.some((fact) => fact.id === id))
      return false;
    const dropped = await this.harness.commit((tx) => dropPlayerFact(tx, playerId, id), context);
    if (dropped) await this.playerChanged(playerId, context);
    return dropped;
  }

  /** Shows a player's own memory in all their rooms, or only in their personal room. */
  async share(playerId: string, shared: boolean, context: Context): Promise<void> {
    await this.knownPlayer(playerId, context);
    await this.harness.commit(async (tx) => {
      (await tx.doc(PlayerMemoryDoc, playerId, null)).shared = shared;
    }, context);
    await this.playerChanged(playerId, context);
  }

  private async knownPlayer(playerId: string, context: Context): Promise<void> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    if (directory?.players[playerId] === undefined) throw new Error(`No player "${playerId}"`);
  }

  /** Every room the player is in may show their facts. */
  private async playerChanged(playerId: string, context: Context): Promise<void> {
    this.changed({ kind: "player-memory", playerId });
    for (const room of await this.rooms.list(context, playerId))
      this.changed({ kind: "memory", roomId: room.id });
  }
}

async function readFacts(read: DocumentReader, roomId: string, context: Context): Promise<Fact[]> {
  const memory = await read.snapshot(MemoryDoc, roomId, context);
  return structuredClone(memory?.facts ?? []);
}

/**
 * The players whose own facts a room shows, with those facts: a personal room's owner always,
 * and in other rooms the members who share theirs (in the lobby, every player who does).
 */
async function sharedFacts(
  read: DocumentReader,
  room: Room,
  context: Context,
): Promise<{ owner: FactPerson; facts: Fact[] }[]> {
  const directory = await read.snapshot(DirectoryDoc, context);
  const ids = room.kind === "lobby" ? Object.keys(directory?.players ?? {}) : room.members;
  const found: { owner: FactPerson; facts: Fact[] }[] = [];
  for (const id of ids) {
    const player = directory?.players[id];
    const memory = await read.snapshot(PlayerMemoryDoc, id, context);
    if (player === undefined || memory === undefined || memory.facts.length === 0) continue;
    if (room.kind !== "personal" && !memory.shared) continue;
    found.push({
      owner: { playerId: id, displayName: player.displayName },
      facts: structuredClone(memory.facts),
    });
  }
  return found;
}

/**
 * The `memory` section: the calling room's facts and its members' shared ones, if any. A private
 * fact shows only in its owner's private turns.
 */
export function memorySection(
  turn: (conversationId: ConversationId, context: Context) => Promise<Turn>,
): PromptSection {
  return section("memory", async (input, context) => {
    const room = await roomOf(input.read, input.conversationId, context);
    const all = await readFacts(input.read, room.id, context);
    const owner = all.some((fact) => fact.privateTo !== undefined)
      ? (await turn(input.conversationId, context)).privateTo?.playerId
      : undefined;
    const facts = all.filter((fact) => visibleIn(fact, owner));
    const shared = await sharedFacts(input.read, room, context);
    const parts: string[] = [];
    if (facts.length > 0)
      parts.push(
        "What you were asked to remember in this conversation:\n" +
          facts
            .map((fact) =>
              fact.privateTo === undefined
                ? `- ${fact.id}: ${fact.text}`
                : `- ${fact.id} (private to ${fact.privateTo.displayName}): ${fact.text}`,
            )
            .join("\n"),
      );
    for (const { owner, facts } of shared)
      parts.push(
        `What ${owner.displayName} asked you to remember about them, in every conversation ` +
          `they share it with:\n${facts.map((fact) => `- ${fact.id}: ${fact.text}`).join("\n")}`,
      );
    return parts.length === 0 ? undefined : parts.join("\n\n");
  });
}

/** Whether a fact shows in a turn private to `owner`, or in a public turn without one. */
function visibleIn(fact: Fact, owner: string | undefined): boolean {
  return fact.privateTo === undefined || fact.privateTo.playerId === owner;
}

/** `remember` and `forget`, about the room the model talks in. */
export function createMemoryTools(
  now: () => number,
  /** Told when a tool changed a player's own memory. */
  changed: (change: Change) => void = () => {},
): ToolRegistration[] {
  const text = (value: string, isError = false) => ({
    output: [{ type: "text" as const, text: value }],
    ...(isError ? { isError } : {}),
  });

  const remember = defineTool({
    name: "remember",
    description:
      "Remember a lasting fact for this conversation, such as a preference, a plan or a name. " +
      "You will see it in every later turn here, also after older messages are summarized. " +
      "Only the people in this conversation can see it. One short fact per call. In someone's " +
      "personal conversation, set `everywhere` for a fact about them that matters wherever they " +
      "are: it goes in their own memory, which they can choose to share with all their " +
      "conversations.",
    parameters: Type.Object({
      fact: Type.String({ description: `At most ${MAX_FACT_LENGTH} characters.` }),
      everywhere: Type.Optional(
        Type.Boolean({ description: "Only in a personal conversation. Default false." }),
      ),
    }),
    execute: async (args, api, context) => {
      const room = await roomOf(api, api.conversationId, context);
      if (args.everywhere === true && room.kind !== "personal")
        return text(
          "Only in someone's personal conversation; here, facts belong to this conversation.",
          true,
        );
      try {
        const fact = await api.commit(
          (tx) =>
            args.everywhere === true
              ? addPlayerFact(tx, room.members[0]!, args.fact, now())
              : addFact(tx, room.id, args.fact, now()),
          context,
        );
        if (args.everywhere === true)
          changed({ kind: "player-memory", playerId: room.members[0]! });
        return text(`Remembered ${fact.id}.`);
      } catch (error) {
        return text((error as Error).message, true);
      }
    },
  });

  const forget = defineTool({
    name: "forget",
    description:
      "Forget a fact this conversation remembers, by its id (like m3). Someone's own facts " +
      "(like p2) can be forgotten only in their personal conversation.",
    parameters: Type.Object({ id: Type.String() }),
    replay: "safe",
    execute: async (args, api, context) => {
      const room = await roomOf(api, api.conversationId, context);
      if (args.id.startsWith("p") && room.kind !== "personal")
        return text(
          `${args.id} is someone's own memory; they can forget it in their personal conversation.`,
          true,
        );
      if (!args.id.startsWith("p")) {
        const fact = (await readFacts(api, room.id, context)).find((fact) => fact.id === args.id);
        if (fact !== undefined && !visibleIn(fact, currentTurn().privateTo?.playerId))
          return text(`No fact ${args.id} in this conversation.`, true);
      }
      const dropped = await api.commit(
        (tx) =>
          args.id.startsWith("p")
            ? dropPlayerFact(tx, room.members[0]!, args.id)
            : dropFact(tx, room.id, args.id),
        context,
      );
      if (dropped && args.id.startsWith("p"))
        changed({ kind: "player-memory", playerId: room.members[0]! });
      return dropped
        ? text(`Forgot ${args.id}.`)
        : text(`No fact ${args.id} in this conversation.`, true);
    },
  });

  return [keepsPlaceholders(remember), forget] as ToolRegistration[];
}
