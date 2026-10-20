import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Keys } from "../federation/keys.ts";
import {
  addressOf,
  type ClientInfo,
  hashToken,
  parseAddress,
  type PlayerHome,
  sameHome,
} from "../identity/directory.ts";

/**
 * Someone who runs the server (ADR 11). Owners create, change and delete assistants and set the
 * model keys; that is apart from being an assistant's admin. Either a person who lives on one of
 * its assistants, signing in with their player there, or a person whose home is elsewhere, who
 * signs in vouched for by it; the server itself is who that home vouches to, so no assistant here
 * is needed for it.
 */
export type ServerOwner = {
  readonly id: string;
  readonly addedAt: number;
  /** For a person who lives here: the assistant, and their player there. */
  readonly assistant?: string;
  readonly playerId?: string;
  /** For a person whose home is elsewhere: their address. */
  readonly address?: string;
  /** Their home's keys, pinned when they were added; absent until it was first reached. */
  readonly keys?: Keys;
};

/** A client signed in as an owner, as listed; the token itself is never kept. */
export type OwnerToken = {
  readonly clientId: string;
  readonly ownerId: string;
  readonly client?: ClientInfo;
  readonly createdAt: number;
};

type Stored = {
  owners: ServerOwner[];
  /** By the token's hash. */
  tokens: Record<string, OwnerToken>;
  /** Assertions from homes already used, until they expire, so none is used twice. */
  used?: Record<string, number>;
};

const TOKEN_PREFIX = "nudge_server_";

export class LastOwner extends Error {
  override name = "LastOwner";
  constructor() {
    super("That would leave the server without an owner");
  }
}

/** Where a server keeps its owners: `server/owners.json` beside its config. */
export function serverOwnersFile(configPath: string): string {
  return join(dirname(resolve(configPath)), "server", "owners.json");
}

/**
 * The server's owners and the tokens they signed in with, in one small file the server and the
 * CLI both read: each change writes it whole, at once. Tokens are kept hashed, as players' are.
 */
export class ServerOwners {
  private memory: Stored | undefined;

  /** Undefined keeps everything in memory, for tests. */
  constructor(
    private readonly file: string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  list(): ServerOwner[] {
    return [...this.read().owners];
  }

  /** The owner a player of `assistant` is, if they are one. */
  ownerOf(assistant: string, playerId: string): ServerOwner | undefined {
    return this.read().owners.find((o) => o.assistant === assistant && o.playerId === playerId);
  }

  /** The owner whose home is `home`, if they are one. */
  ownerAt(home: PlayerHome): ServerOwner | undefined {
    return this.read().owners.find((owner) => {
      const at = owner.address === undefined ? undefined : parseAddress(owner.address);
      return at !== undefined && sameHome(at, home);
    });
  }

  /**
   * Makes a person whose home is elsewhere an owner, with their home's keys; one already is keeps
   * their keys. Undefined when `address` isn't one.
   */
  addAddress(address: string, keys?: Keys): ServerOwner | undefined {
    const home = parseAddress(address);
    if (home === undefined) return undefined;
    const known = this.ownerAt(home);
    if (known !== undefined) return known;
    const owner: ServerOwner = {
      id: randomUUID(),
      address: addressOf(home),
      ...(keys === undefined ? {} : { keys }),
      addedAt: this.now(),
    };
    this.change((stored) => stored.owners.push(owner));
    return owner;
  }

  /** Pins new keys for an owner's home, as when it rotated them or was first reached. */
  repin(id: string, keys: Keys): void {
    this.change((stored) => {
      stored.owners = stored.owners.map((owner) => (owner.id === id ? { ...owner, keys } : owner));
    });
  }

  /** False when the assertion with this nonce was used before; it is used now. */
  useNonce(nonce: string, expiresAt: number): boolean {
    const now = this.now();
    if ((this.read().used ?? {})[nonce] !== undefined) return false;
    this.change((stored) => {
      const used = Object.fromEntries(
        Object.entries(stored.used ?? {}).filter(([, expires]) => expires >= now),
      );
      stored.used = { ...used, [nonce]: expiresAt };
    });
    return true;
  }

  /**
   * Turns the owners of an older server (v0.6.0), who were each a player of an assistant here,
   * into owners by address when that player's home is elsewhere: `homeOf` says where. Ids, and so
   * tokens, stay; one person who was an owner through two assistants becomes one owner. Their
   * home's keys, from `keysOf`, are pinned when it answers, or on their first sign-in.
   */
  async migrate(
    homeOf: (owner: ServerOwner) => Promise<PlayerHome | undefined>,
    keysOf: (home: PlayerHome) => Promise<Keys | undefined>,
  ): Promise<void> {
    const moved = new Map<string, { home: PlayerHome; keys: Keys | undefined }>();
    for (const owner of this.list()) {
      if (owner.assistant === undefined || owner.playerId === undefined) continue;
      const home = await homeOf(owner);
      if (home !== undefined) moved.set(owner.id, { home, keys: await keysOf(home) });
    }
    if (moved.size === 0) return;
    this.change((stored) => {
      const kept: ServerOwner[] = [];
      for (const owner of stored.owners) {
        const found = moved.get(owner.id);
        if (found === undefined) {
          kept.push(owner);
          continue;
        }
        const same = kept.find((o) => o.address === addressOf(found.home));
        if (same !== undefined) {
          for (const token of Object.values(stored.tokens))
            if (token.ownerId === owner.id) (token as { ownerId: string }).ownerId = same.id;
          continue;
        }
        kept.push({
          id: owner.id,
          address: addressOf(found.home),
          ...(found.keys === undefined ? {} : { keys: found.keys }),
          addedAt: owner.addedAt,
        });
      }
      stored.owners = kept;
    });
  }

  /** Makes a player of one of the server's assistants an owner; one already is stays as they are. */
  add(assistant: string, playerId: string): ServerOwner {
    const known = this.ownerOf(assistant, playerId);
    if (known !== undefined) return known;
    const owner: ServerOwner = { id: randomUUID(), assistant, playerId, addedAt: this.now() };
    this.change((stored) => stored.owners.push(owner));
    return owner;
  }

  /** Takes an owner away, with every token they signed in with. Refuses the last one. */
  remove(id: string): boolean {
    const stored = this.read();
    if (!stored.owners.some((owner) => owner.id === id)) return false;
    if (stored.owners.length === 1) throw new LastOwner();
    this.change((next) => {
      next.owners = next.owners.filter((owner) => owner.id !== id);
      for (const [hash, token] of Object.entries(next.tokens))
        if (token.ownerId === id) delete next.tokens[hash];
    });
    return true;
  }

  /**
   * Whether deleting `assistant` would leave no owner: every owner lives there. Owners from other
   * assistants, or whose home is elsewhere, keep the server.
   */
  wouldLeaveNoOwner(assistant: string): boolean {
    const { owners } = this.read();
    return owners.length > 0 && owners.every((owner) => owner.assistant === assistant);
  }

  /** Drops the owners who lived on a deleted assistant; those whose home is elsewhere stay. */
  forgetAssistant(assistant: string): void {
    for (const owner of this.list()) {
      if (owner.assistant !== assistant) continue;
      this.change((next) => {
        next.owners = next.owners.filter((o) => o.id !== owner.id);
        for (const [hash, token] of Object.entries(next.tokens))
          if (token.ownerId === owner.id) delete next.tokens[hash];
      });
    }
  }

  /** A new token for the owner, shown once. */
  issue(ownerId: string, client?: ClientInfo): { token: string; clientId: string } {
    if (!this.read().owners.some((owner) => owner.id === ownerId))
      throw new Error(`No owner "${ownerId}"`);
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const clientId = randomUUID();
    this.change((stored) => {
      stored.tokens[hashToken(token)] = {
        clientId,
        ownerId,
        ...(client === undefined ? {} : { client }),
        createdAt: this.now(),
      };
    });
    return { token, clientId };
  }

  /** The owner a token signs in as, while they are still an owner. */
  authenticate(token: string): { owner: ServerOwner; clientId: string } | undefined {
    if (!token.startsWith(TOKEN_PREFIX)) return undefined;
    const stored = this.read();
    const record = stored.tokens[hashToken(token)];
    const owner = stored.owners.find((o) => o.id === record?.ownerId);
    return record === undefined || owner === undefined
      ? undefined
      : { owner, clientId: record.clientId };
  }

  tokens(): OwnerToken[] {
    return Object.values(this.read().tokens);
  }

  /** False when no token had that client id. */
  revoke(clientId: string): boolean {
    const found = Object.entries(this.read().tokens).find(([, t]) => t.clientId === clientId);
    if (found === undefined) return false;
    this.change((stored) => void delete stored.tokens[found[0]]);
    return true;
  }

  private read(): Stored {
    if (this.file === undefined) return (this.memory ??= { owners: [], tokens: {} });
    // Read every time: the CLI may have changed it while the server runs.
    if (!existsSync(this.file)) return { owners: [], tokens: {} };
    return JSON.parse(readFileSync(this.file, "utf8")) as Stored;
  }

  private change(edit: (stored: Stored) => void): void {
    const stored = structuredClone(this.read());
    edit(stored);
    if (this.file === undefined) {
      this.memory = stored;
      return;
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
