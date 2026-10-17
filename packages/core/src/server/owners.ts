import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type ClientInfo, hashToken } from "../identity/directory.ts";

/**
 * Someone who runs the server (ADR 11): a player of one of its assistants. Owners create, change
 * and delete assistants and set the model keys; that is apart from being an assistant's admin.
 */
export type ServerOwner = {
  readonly id: string;
  readonly assistant: string;
  readonly playerId: string;
  readonly addedAt: number;
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
   * Whether deleting `assistant` would leave no owner: every owner is one of its players. Owners
   * from other assistants keep the server.
   */
  wouldLeaveNoOwner(assistant: string): boolean {
    const { owners } = this.read();
    return owners.length > 0 && owners.every((owner) => owner.assistant === assistant);
  }

  /** Drops the owners who were players of a deleted assistant. */
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
