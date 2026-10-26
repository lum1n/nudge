import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SecretStore } from "@nudge/core";
import { type AccBackend, type AccHost, accErrorCode, type SshConfig } from "./native.ts";

/** A host from the settings, its password filled in. */
export type HostEntry = {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** `local`: this machine, as the user Nudge runs as, with no login. */
  readonly auth: "key" | "agent" | "password" | "local";
  readonly password?: string;
  /** Room ids that may use it, `*` for every room. */
  readonly rooms: readonly string[];
};

type KeyPair = { readonly privateKey: string; readonly publicKey: string };

/**
 * The hosts' connections, logging in with a key of the extension's own (made on first use, kept in
 * its secret store) and pinning each host's key the first time it connects: a host that later
 * shows another key is refused until someone trusts the new one.
 */
export class Hosts {
  private readonly connections = new Map<string, Promise<AccHost>>();
  private pins: Record<string, string> | undefined;
  private added: HostEntry[] | undefined;
  /** Hosts whose key changed, with the key they show now. */
  readonly changedKeys = new Map<string, string>();

  constructor(
    /** The machines from the settings. */
    private readonly configured: readonly HostEntry[],
    private readonly backend: AccBackend,
    private readonly secrets: SecretStore,
    /** Where pinned host keys are kept; in memory only when absent. */
    private readonly pinsFile: string | undefined,
    private readonly comment: string,
    /** Where machines added at runtime are kept; in memory only when absent. */
    private readonly addedFile?: string,
  ) {}

  /** The machines from the settings, then those added at runtime. */
  get entries(): readonly HostEntry[] {
    return [...this.configured, ...this.loadAdded()];
  }

  /**
   * Adds a machine at runtime, such as a project's VM, kept across restarts; replaces one added
   * before under the name. A name the settings use is refused. Logs in with the extension's key.
   */
  async add(entry: Omit<HostEntry, "auth" | "password">): Promise<void> {
    if (this.configured.some((other) => other.name.toLowerCase() === entry.name.toLowerCase()))
      throw new Error(`The settings have a machine "${entry.name}" already.`);
    const kept = this.loadAdded().filter((other) => other.name !== entry.name);
    this.saveAdded([...kept, { ...entry, auth: "key" }]);
    await this.drop(entry.name);
  }

  /** Removes a machine added at runtime, and forgets its pinned key. False when there was none. */
  async remove(name: string): Promise<boolean> {
    const kept = this.loadAdded().filter((other) => other.name !== name);
    if (kept.length === this.loadAdded().length) return false;
    this.saveAdded(kept);
    const pins = { ...this.loadPins() };
    delete pins[name];
    this.savePins(pins);
    await this.drop(name);
    return true;
  }

  /** The entries a room may use. */
  usableIn(roomId: string): HostEntry[] {
    return this.entries.filter(
      (entry) => entry.rooms.includes("*") || entry.rooms.includes(roomId),
    );
  }

  /** The `authorized_keys` line hosts let the extension in with. */
  publicKey(): string {
    return this.key().publicKey;
  }

  /** The host key pinned for `name`, if it connected before. */
  pinned(name: string): string | undefined {
    return this.loadPins()[name];
  }

  /** A connected host, pinning its key on first connect. */
  async connect(name: string): Promise<AccHost> {
    const entry = this.entries.find((candidate) => candidate.name === name);
    if (entry === undefined)
      throw new Error(
        `No host "${name}"; there is ${this.entries.map((e) => e.name).join(", ") || "none"}.`,
      );
    let connection = this.connections.get(name);
    if (connection === undefined) {
      connection = this.open(entry);
      this.connections.set(name, connection);
      // A failed connect is tried afresh next time.
      connection.catch(() => {
        if (this.connections.get(name) === connection) this.connections.delete(name);
      });
    }
    return connection;
  }

  /** Forgets `name`'s pinned key, so the next connect trusts and pins the key it shows then. */
  async trustNewKey(name: string): Promise<void> {
    const pins = { ...this.loadPins() };
    delete pins[name];
    this.savePins(pins);
    this.changedKeys.delete(name);
    await this.drop(name);
  }

  /** Closes `name`'s connection, if open; the next use connects afresh. */
  private async drop(name: string): Promise<void> {
    const connection = this.connections.get(name);
    this.connections.delete(name);
    await connection?.then((host) => host.disconnect()).catch(() => undefined);
  }

  async close(): Promise<void> {
    const open = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(
      open.map((connection) => connection.then((host) => host.disconnect()).catch(() => undefined)),
    );
  }

  private async open(entry: HostEntry): Promise<AccHost> {
    if (entry.auth === "local") {
      if (this.backend.localHost === undefined)
        throw new Error("This ACC binding can't reach this machine's sessions; it needs updating.");
      return this.backend.localHost();
    }
    const pin = this.pinned(entry.name);
    const config: SshConfig = {
      host: entry.host,
      port: entry.port,
      user: entry.user,
      auth:
        entry.auth === "agent"
          ? { agent: true }
          : entry.auth === "password"
            ? { password: entry.password ?? "" }
            : { privateKey: this.key().privateKey },
      hostKey: pin === undefined ? { acceptAny: true } : { fingerprints: [pin] },
      connectTimeoutMs: 10_000,
    };
    const host = this.backend.host(config);
    try {
      await host.connect();
    } catch (error) {
      if (accErrorCode(error) === "HostKeyRejected") {
        const shown = /SHA256:\S+/.exec((error as Error).message)?.[0] ?? "another key";
        this.changedKeys.set(entry.name, shown);
        throw new Error(
          `${entry.name} showed a different host key (${shown}) than the one it had (${pin}). ` +
            "That happens when the machine was reinstalled, or when something is in between. " +
            "Nothing was sent. An admin can trust the new key with acc_hosts.",
          { cause: error },
        );
      }
      if (accErrorCode(error) === "AuthRejected" && entry.auth === "key")
        throw new Error(
          `${entry.name} didn't accept the assistant's key. Add this line to ~/.ssh/authorized_keys ` +
            `for ${entry.user} there:\n${this.publicKey()}`,
          { cause: error },
        );
      throw error;
    }
    if (pin === undefined) {
      const shown = host.hostKeyFingerprint();
      if (shown !== null) this.savePins({ ...this.loadPins(), [entry.name]: shown });
    }
    return host;
  }

  private key(): KeyPair {
    const stored = this.secrets.get("ssh", "key");
    if (stored !== undefined) return JSON.parse(stored) as KeyPair;
    const made = this.backend.generateKey(this.comment);
    this.secrets.set("ssh", "key", JSON.stringify(made));
    return made;
  }

  private loadPins(): Record<string, string> {
    if (this.pins !== undefined) return this.pins;
    try {
      this.pins =
        this.pinsFile === undefined
          ? {}
          : (JSON.parse(readFileSync(this.pinsFile, "utf8")) as Record<string, string>);
    } catch {
      this.pins = {};
    }
    return this.pins;
  }

  private loadAdded(): HostEntry[] {
    if (this.added !== undefined) return this.added;
    try {
      this.added =
        this.addedFile === undefined
          ? []
          : (JSON.parse(readFileSync(this.addedFile, "utf8")) as HostEntry[]);
    } catch {
      this.added = [];
    }
    return this.added;
  }

  private saveAdded(added: HostEntry[]): void {
    this.added = added;
    if (this.addedFile === undefined) return;
    mkdirSync(dirname(this.addedFile), { recursive: true });
    writeFileSync(this.addedFile, `${JSON.stringify(added, null, 2)}\n`);
  }

  private savePins(pins: Record<string, string>): void {
    this.pins = pins;
    if (this.pinsFile === undefined) return;
    mkdirSync(dirname(this.pinsFile), { recursive: true });
    writeFileSync(this.pinsFile, `${JSON.stringify(pins, null, 2)}\n`);
  }
}
