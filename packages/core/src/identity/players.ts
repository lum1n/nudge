import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import {
  DirectoryDoc,
  freeId,
  hashToken,
  newToken,
  type Player,
  slug,
  type TokenRecord,
} from "./directory.ts";

/** What a valid token stands for. */
export type Credential = { readonly player: Player; readonly clientId: string };

export type Invitation = Credential & {
  /** Shown once; only its hash is kept. */
  readonly token: string;
};

/** The people who use one assistant, and their tokens. */
export class Players {
  constructor(
    private readonly harness: Harness,
    /** Keeps a display name from the model before anything can mention it. */
    private readonly protectName: (name: string) => Promise<void>,
    private readonly now: () => number,
  ) {}

  async list(context: Context): Promise<Player[]> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    return Object.values(directory?.players ?? {}).sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(id: string, context: Context): Promise<Player | undefined> {
    return (await this.harness.snapshot(DirectoryDoc, context))?.players[id];
  }

  /** Adds a player with a fresh id taken from the name, and a token for their first client. */
  async invite(displayName: string, context: Context): Promise<Invitation> {
    const name = displayName.trim();
    if (name === "") throw new Error("A player needs a name");
    await this.protectName(name);
    const token = newToken();
    const clientId = `client-${randomUUID()}`;
    const player = await this.harness.commit(async (tx) => {
      const directory = await tx.doc(DirectoryDoc);
      const id = freeId(slug(name, "player"), (id) => id in directory.players);
      const player: Player = { id, displayName: name, createdAt: this.now() };
      directory.players[id] = { ...player };
      directory.tokens[hashToken(token)] = { playerId: id, clientId, createdAt: this.now() };
      return player;
    }, context);
    return { player, clientId, token };
  }

  /** Creates the player `id`, or renames it to `displayName`. For hosts that know who is there. */
  async ensure(id: string, displayName: string, context: Context): Promise<Player> {
    const name = displayName.trim();
    if (name === "") throw new Error("A player needs a name");
    await this.protectName(name);
    return this.harness.commit(async (tx) => {
      const directory = await tx.doc(DirectoryDoc);
      const existing = directory.players[id];
      if (existing !== undefined) {
        if (existing.displayName !== name) existing.displayName = name;
        return { ...existing };
      }
      const player: Player = { id, displayName: name, createdAt: this.now() };
      directory.players[id] = { ...player };
      return player;
    }, context);
  }

  /** Another token for an existing player, such as for a second device. */
  async issueToken(playerId: string, context: Context): Promise<Invitation> {
    const token = newToken();
    const clientId = `client-${randomUUID()}`;
    const player = await this.harness.commit(async (tx) => {
      const directory = await tx.doc(DirectoryDoc);
      const player = directory.players[playerId];
      if (player === undefined) throw new Error(`No player "${playerId}"`);
      directory.tokens[hashToken(token)] = { playerId, clientId, createdAt: this.now() };
      return { ...player };
    }, context);
    return { player, clientId, token };
  }

  /** Every token's record, oldest first; only `playerId`'s when given. The tokens themselves are gone. */
  async tokens(playerId: string | undefined, context: Context): Promise<TokenRecord[]> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    if (playerId !== undefined && directory?.players[playerId] === undefined)
      throw new Error(`No player "${playerId}"`);
    return Object.values(directory?.tokens ?? {})
      .filter((record) => playerId === undefined || record.playerId === playerId)
      .map((record) => ({ ...record }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Stops the token of client `clientId` from signing in, and returns its record. */
  async revoke(clientId: string, context: Context): Promise<TokenRecord> {
    return this.harness.commit(async (tx) => {
      const directory = await tx.doc(DirectoryDoc);
      const hash = Object.keys(directory.tokens).find(
        (hash) => directory.tokens[hash]!.clientId === clientId,
      );
      if (hash === undefined) throw new Error(`No token for client "${clientId}"`);
      const record = { ...directory.tokens[hash]! };
      delete directory.tokens[hash];
      return record;
    }, context);
  }

  async authenticate(token: string, context: Context): Promise<Credential | undefined> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    const record = directory?.tokens[hashToken(token)];
    const player = record === undefined ? undefined : directory?.players[record.playerId];
    return player === undefined ? undefined : { player, clientId: record!.clientId };
  }
}
