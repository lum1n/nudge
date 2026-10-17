import type { Context } from "@earendil-works/chord";
import type { AgentChange, ConversationId, Harness } from "@earendil-works/pi-durable";
import type { Change } from "../changes.ts";
import { canUse, DirectoryDoc, freeId, LOBBY, type Player, type Room, slug } from "./directory.ts";

export type SharedRoomDraft = {
  readonly name: string;
  /** Player ids. */
  readonly members: readonly string[];
  /** URL-safe; default: taken from the name. */
  readonly id?: string;
};

/** The assistant's conversations, by room id. Every room is one Pi Durable conversation. */
export class Rooms {
  constructor(
    private readonly harness: Harness,
    /** The model, instructions and extensions a new room starts with. */
    private readonly agent: (room: Pick<Room, "kind" | "extensions">) => AgentChange,
    private readonly now: () => number,
    private readonly changed: (change: Change) => void = () => {},
  ) {}

  async get(id: string, context: Context): Promise<Room | undefined> {
    return (await this.harness.snapshot(DirectoryDoc, context))?.rooms[id];
  }

  /** Every room, or the rooms `playerId` may use. */
  async list(context: Context, playerId?: string): Promise<Room[]> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    return Object.values(directory?.rooms ?? {})
      .filter((room) => playerId === undefined || canUse(room, playerId))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Who may read the room: every player for the lobby. */
  async members(roomId: string, context: Context): Promise<Player[]> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    const room = directory?.rooms[roomId];
    if (directory === undefined || room === undefined) return [];
    const ids = room.kind === "lobby" ? Object.keys(directory.players) : room.members;
    return ids.map((id) => directory.players[id]).filter((player) => player !== undefined);
  }

  /** `playerId`'s own room, created on first use. */
  async ensurePersonal(playerId: string, context: Context): Promise<Room> {
    const id = `personal-${playerId}`;
    const existing = await this.get(id, context);
    if (existing !== undefined) return existing;
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    const player = directory?.players[playerId];
    if (player === undefined) throw new Error(`No player "${playerId}"`);
    try {
      return await this.create(
        { id, kind: "personal", name: `${player.displayName}'s room`, members: [playerId] },
        context,
      );
    } catch (error) {
      // Two clients asked at once; the other one made it.
      const made = await this.get(id, context);
      if (made !== undefined) return made;
      throw error;
    }
  }

  async createShared(draft: SharedRoomDraft, context: Context): Promise<Room> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    for (const member of draft.members)
      if (directory?.players[member] === undefined) throw new Error(`No player "${member}"`);
    if (draft.id !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(draft.id))
      throw new Error(`Room id "${draft.id}" is not lower-case letters, digits and dashes`);
    const id =
      draft.id ??
      freeId(slug(draft.name, "room"), (id) => id === LOBBY || id in (directory?.rooms ?? {}));
    return this.create(
      { id, kind: "shared", name: draft.name, members: [...new Set(draft.members)] },
      context,
    );
  }

  /** Gives the room a new name; its id, and so links to it, stay. */
  async rename(id: string, name: string, context: Context): Promise<Room> {
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("A room needs a name");
    const room = await this.harness.commit(async (tx) => {
      const room = (await tx.doc(DirectoryDoc)).rooms[id];
      if (room === undefined) throw new Error(`No room "${id}"`);
      room.name = trimmed;
      return {
        ...room,
        members: [...room.members],
        ...(room.extensions === undefined ? {} : { extensions: { ...room.extensions } }),
      };
    }, context);
    this.changed({ kind: "rooms" });
    return room;
  }

  /** Records the lobby, the root conversation, in the directory. */
  async adoptLobby(conversationId: ConversationId, context: Context): Promise<void> {
    if ((await this.get(LOBBY, context)) !== undefined) return;
    await this.harness.commit(async (tx) => {
      const directory = await tx.doc(DirectoryDoc);
      directory.rooms[LOBBY] ??= {
        id: LOBBY,
        conversationId,
        kind: "lobby",
        name: "Lobby",
        members: [],
        createdAt: this.now(),
      };
    }, context);
  }

  private async create(
    room: Omit<Room, "conversationId" | "createdAt">,
    context: Context,
  ): Promise<Room> {
    let created: Room | undefined;
    await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: this.agent(room),
        // The conversation and its directory entry commit together, so neither exists alone.
        init: async (tx, conversationId) => {
          const directory = await tx.doc(DirectoryDoc);
          if (directory.rooms[room.id] !== undefined)
            throw new Error(`Room "${room.id}" already exists`);
          created = { ...room, members: [...room.members], conversationId, createdAt: this.now() };
          directory.rooms[room.id] = { ...created, members: [...created.members] };
        },
      },
      context,
    );
    this.changed({ kind: "rooms" });
    return created!;
  }

  /**
   * A new side conversation of the room: the room's model, instructions and extensions, its own
   * transcript. Returns its conversation id.
   */
  async createSide(roomId: string, context: Context): Promise<number> {
    const room = await this.get(roomId, context);
    if (room === undefined) throw new Error(`No room "${roomId}"`);
    let id: number | undefined;
    await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: this.agent(room),
        init: async (tx, conversationId) => {
          const directory = await tx.doc(DirectoryDoc);
          if (directory.rooms[roomId] === undefined) throw new Error(`No room "${roomId}"`);
          // Assigned, then written through the document: `??=` would hand back the plain object.
          directory.sides ??= {};
          directory.sides[String(conversationId)] = { roomId, createdAt: this.now() };
          id = conversationId;
        },
      },
      context,
    );
    return id!;
  }

  /** Forgets a side conversation; its transcript stays in storage, unused. */
  async dropSide(conversationId: number, context: Context): Promise<void> {
    await this.harness.commit(async (tx) => {
      delete (await tx.doc(DirectoryDoc)).sides?.[String(conversationId)];
    }, context);
  }

  /** The room's side conversations' ids. */
  async sides(roomId: string, context: Context): Promise<number[]> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    return Object.entries(directory?.sides ?? {})
      .filter(([, side]) => side.roomId === roomId)
      .map(([id]) => Number(id));
  }
}
