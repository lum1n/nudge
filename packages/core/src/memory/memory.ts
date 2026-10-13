import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  type DocumentReader,
  defineDocFamily,
  defineTool,
  type Harness,
  type PromptSection,
  section,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { roomOf } from "../identity/directory.ts";
import type { Rooms } from "../identity/rooms.ts";

// Stored in a document, so plain JSON.
export type Fact = {
  /** `m1`, `m2`, … within its room. */
  id: string;
  text: string;
  createdAt: number;
};

export type MemoryState = {
  /** Oldest first. */
  facts: Fact[];
  next: number;
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
});

export const MAX_FACTS = 100;
export const MAX_FACT_LENGTH = 500;

export class MemoryFull extends Error {
  override name = "MemoryFull";
}

/** Adds a fact to a room's memory inside a commit. */
export async function addFact(tx: Tx, roomId: string, text: string, now: number): Promise<Fact> {
  const fact = text.trim().replace(/\s+/g, " ");
  if (fact === "") throw new Error("A fact needs text");
  if (fact.length > MAX_FACT_LENGTH)
    throw new Error(`A fact is at most ${MAX_FACT_LENGTH} characters`);
  const memory = await tx.doc(MemoryDoc, roomId, null);
  if (memory.facts.length >= MAX_FACTS)
    throw new MemoryFull(
      `This conversation remembers ${MAX_FACTS} facts already; forget one first`,
    );
  const added: Fact = { id: `m${memory.next}`, text: fact, createdAt: now };
  memory.next += 1;
  memory.facts.push({ ...added });
  return added;
}

/** Drops a fact from a room's memory inside a commit. False when it has none with that id. */
export async function dropFact(tx: Tx, roomId: string, id: string): Promise<boolean> {
  const memory = await tx.doc(MemoryDoc, roomId, null);
  const index = memory.facts.findIndex((fact) => fact.id === id);
  if (index < 0) return false;
  memory.facts.splice(index, 1);
  return true;
}

/** Each room's memory, for hosts: list, add and forget what the model sees there. */
export class Memory {
  constructor(
    private readonly harness: Harness,
    private readonly rooms: Rooms,
    private readonly now: () => number,
  ) {}

  async list(roomId: string, context: Context): Promise<Fact[]> {
    return readFacts(this.harness, roomId, context);
  }

  async remember(roomId: string, text: string, context: Context): Promise<Fact> {
    if ((await this.rooms.get(roomId, context)) === undefined)
      throw new Error(`No room "${roomId}"`);
    return this.harness.commit((tx) => addFact(tx, roomId, text, this.now()), context);
  }

  /** False when the room has no fact with that id. */
  async forget(roomId: string, id: string, context: Context): Promise<boolean> {
    if (!(await readFacts(this.harness, roomId, context)).some((fact) => fact.id === id))
      return false;
    return this.harness.commit((tx) => dropFact(tx, roomId, id), context);
  }
}

async function readFacts(read: DocumentReader, roomId: string, context: Context): Promise<Fact[]> {
  const memory = await read.snapshot(MemoryDoc, roomId, context);
  return (memory?.facts ?? []).map((fact) => ({ ...fact }));
}

/** The `memory` section: the calling room's facts, or nothing while there are none. */
export function memorySection(): PromptSection {
  return section("memory", async (input, context) => {
    const room = await roomOf(input.read, input.conversationId, context);
    const facts = await readFacts(input.read, room.id, context);
    if (facts.length === 0) return undefined;
    return (
      "What you were asked to remember in this conversation:\n" +
      facts.map((fact) => `- ${fact.id}: ${fact.text}`).join("\n")
    );
  });
}

/** `remember` and `forget`, about the room the model talks in. */
export function createMemoryTools(now: () => number): ToolRegistration[] {
  const text = (value: string, isError = false) => ({
    output: [{ type: "text" as const, text: value }],
    ...(isError ? { isError } : {}),
  });

  const remember = defineTool({
    name: "remember",
    description:
      "Remember a lasting fact for this conversation, such as a preference, a plan or a name. " +
      "You will see it in every later turn here, also after older messages are summarized. " +
      "Only the people in this conversation can see it. One short fact per call.",
    parameters: Type.Object({
      fact: Type.String({ description: `At most ${MAX_FACT_LENGTH} characters.` }),
    }),
    execute: async (args, api, context) => {
      const room = await roomOf(api, api.conversationId, context);
      try {
        const fact = await api.commit((tx) => addFact(tx, room.id, args.fact, now()), context);
        return text(`Remembered ${fact.id}.`);
      } catch (error) {
        return text((error as Error).message, true);
      }
    },
  });

  const forget = defineTool({
    name: "forget",
    description: "Forget a fact this conversation remembers, by its id (like m3).",
    parameters: Type.Object({ id: Type.String() }),
    replay: "safe",
    execute: async (args, api, context) => {
      const room = await roomOf(api, api.conversationId, context);
      const dropped = await api.commit((tx) => dropFact(tx, room.id, args.id), context);
      return dropped
        ? text(`Forgot ${args.id}.`)
        : text(`No fact ${args.id} in this conversation.`, true);
    },
  });

  return [remember, forget] as ToolRegistration[];
}
