import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import {
  type ClientInfo,
  DirectoryDoc,
  type DirectoryState,
  freeId,
  hashToken,
  newPairingCode,
  newToken,
  normalizePairingCode,
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

export type PairingCode = {
  /** Shown once; only its hash is kept. */
  readonly code: string;
  readonly player: Player;
  readonly expiresAt: number;
};

/** How long a pairing code works. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

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
    const token = newToken();
    const clientId = `client-${randomUUID()}`;
    const player = await this.add(displayName, { token, clientId }, context);
    return { player, clientId, token };
  }

  /** Adds a player with a fresh id taken from the name and no token; pair a client for one. */
  async create(displayName: string, context: Context): Promise<Player> {
    return this.add(displayName, undefined, context);
  }

  private async add(
    displayName: string,
    first: { readonly token: string; readonly clientId: string } | undefined,
    context: Context,
  ): Promise<Player> {
    const name = displayName.trim();
    if (name === "") throw new Error("A player needs a name");
    await this.protectName(name);
    return this.harness.commit(async (tx) => {
      const directory = await tx.doc(DirectoryDoc);
      const id = freeId(slug(name, "player"), (id) => id in directory.players);
      const player: Player = { id, displayName: name, createdAt: this.now() };
      directory.players[id] = { ...player };
      if (first !== undefined)
        directory.tokens[hashToken(first.token)] = {
          playerId: id,
          clientId: first.clientId,
          createdAt: this.now(),
        };
      return player;
    }, context);
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

  /** A code that a new client of `playerId` trades for a token with `pair`, once, within ten minutes. */
  async pairingCode(playerId: string, context: Context): Promise<PairingCode> {
    const code = newPairingCode();
    const now = this.now();
    const expiresAt = now + PAIRING_TTL_MS;
    const player = await this.harness.commit(async (tx) => {
      const directory = await tx.doc(DirectoryDoc);
      const player = directory.players[playerId];
      if (player === undefined) throw new Error(`No player "${playerId}"`);
      // Set first and read back: the document tracks changes made through itself.
      directory.pairing ??= {};
      const pairing = directory.pairing;
      dropExpired(pairing, now);
      pairing[hashToken(normalizePairingCode(code))] = { playerId, createdAt: now, expiresAt };
      return { ...player };
    }, context);
    return { code, player, expiresAt };
  }

  /** Trades a pairing code for a token of its player; undefined when it is unknown, used or expired. */
  async pair(code: string, client: ClientInfo, context: Context): Promise<Invitation | undefined> {
    const token = newToken();
    const clientId = `client-${randomUUID()}`;
    const now = this.now();
    const hash = hashToken(normalizePairingCode(code));
    // Read first, so a wrong code costs no commit.
    if ((await this.harness.snapshot(DirectoryDoc, context))?.pairing?.[hash] === undefined)
      return undefined;
    const player = await this.harness.commit(async (tx) => {
      const directory = await tx.doc(DirectoryDoc);
      const pairing = directory.pairing ?? {};
      const record = pairing[hash];
      if (record === undefined) return undefined;
      delete pairing[hash];
      dropExpired(pairing, now);
      const player = directory.players[record.playerId];
      if (record.expiresAt <= now || player === undefined) return undefined;
      directory.tokens[hashToken(token)] = {
        playerId: player.id,
        clientId,
        createdAt: now,
        client: { name: client.name, platform: client.platform },
      };
      return { ...player };
    }, context);
    return player === undefined ? undefined : { player, clientId, token };
  }

  /** Whether `playerId` may use the admin API: marked so, or the first player. */
  async isAdmin(playerId: string, context: Context): Promise<boolean> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    return directory !== undefined && isAdmin(directory, playerId);
  }

  /** Marks `playerId` as an admin, or not. The first player stays one either way. */
  async setAdmin(playerId: string, admin: boolean, context: Context): Promise<Player> {
    return this.harness.commit(async (tx) => {
      const directory = await tx.doc(DirectoryDoc);
      const player = directory.players[playerId];
      if (player === undefined) throw new Error(`No player "${playerId}"`);
      if (admin) player.admin = true;
      else delete player.admin;
      return { ...player };
    }, context);
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

export function isAdmin(directory: Readonly<DirectoryState>, playerId: string): boolean {
  const player = directory.players[playerId];
  if (player === undefined) return false;
  if (player.admin === true) return true;
  const first = Object.values(directory.players).reduce<Player | undefined>(
    (first, p) => (first === undefined || p.createdAt < first.createdAt ? p : first),
    undefined,
  );
  return first?.id === playerId;
}

function dropExpired(pairing: NonNullable<DirectoryState["pairing"]>, now: number): void {
  for (const [hash, record] of Object.entries(pairing))
    if (record.expiresAt <= now) delete pairing[hash];
}
