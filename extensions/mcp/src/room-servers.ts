import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { McpAuthRequiredError, type CallToolResult, type Tool } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { scrubSecrets, type SecretStore } from "@nudge/core";
import type { OAuthLogins } from "./oauth.ts";
import type { McpPool, ServerConfig } from "./pool.ts";
import type { RoomServer, ServerKey } from "./rooms.ts";

/** Where a key's value is kept in the extension's secrets, scoped by room. */
export const keySecret = (serverId: string, key: Pick<ServerKey, "in" | "name">) =>
  `${serverId}/${key.in}/${key.name}`;

/** Where people go to set keys and sign in, as the model tells them. */
export const PANEL =
  "the room's MCP servers panel (in the web app's room menu, or About this room in the apps)";

/**
 * The servers rooms added, as the pool reaches them: their configs with the keys people set,
 * their tool lists once read, and what went wrong last, for the panel and the model.
 */
export class RoomServers {
  /** Each server as last seen, by pool key, so the pool can build its config when it connects. */
  private readonly known = new Map<string, { roomId: string; server: RoomServer }>();
  private readonly listed = new Map<string, Promise<Tool[]>>();
  private readonly problems = new Map<string, string>();

  constructor(
    private readonly pool: McpPool,
    private readonly secrets: SecretStore,
    private readonly logins: OAuthLogins,
    private readonly timeoutMs: number,
    private readonly dataDir: string | undefined,
    /** More directories the programs may read, from the extension's settings. */
    private readonly readable: readonly string[] = [],
  ) {}

  static key(roomId: string, serverId: string): string {
    return `room/${roomId}/${serverId}`;
  }

  /** The pool's config for a room server; undefined for a key that isn't one. */
  config(key: string): ServerConfig | undefined {
    const found = this.known.get(key);
    if (found === undefined) return undefined;
    const { roomId, server } = found;
    const values = (kind: ServerKey["in"]) =>
      Object.fromEntries(
        server.keys
          .filter((key) => key.in === kind)
          .map((key) => [key.name, `${key.prefix ?? ""}${this.value(roomId, server, key) ?? ""}`]),
      );
    if (server.url !== undefined) {
      const authProvider = this.logins.authProvider(roomId, server.id, server.url);
      return {
        url: server.url,
        headers: { ...server.headers, ...values("header") },
        ...(authProvider === undefined ? {} : { authProvider }),
        timeoutMs: this.timeoutMs,
      };
    }
    let home: string | undefined;
    if (this.dataDir !== undefined) {
      home = join(this.dataDir, "rooms", roomId, server.id);
      mkdirSync(home, { recursive: true, mode: 0o700 });
    }
    // Always sandboxed: a room's program sees its own directory as its home, not Nudge's data.
    return {
      command: server.command!,
      ...(server.args === undefined ? {} : { args: server.args }),
      env: { ...server.env, ...values("env") },
      sandbox: { ...(home === undefined ? {} : { home }), readable: this.readable },
      timeoutMs: this.timeoutMs,
    };
  }

  /** The keys people still have to set. */
  missingKeys(roomId: string, server: RoomServer): ServerKey[] {
    return server.keys.filter((key) => this.value(roomId, server, key) === undefined);
  }

  hasValue(roomId: string, server: RoomServer, key: ServerKey): boolean {
    return this.value(roomId, server, key) !== undefined;
  }

  problem(roomId: string, serverId: string): string | undefined {
    return this.problems.get(RoomServers.key(roomId, serverId));
  }

  /** The number of tools, once they were read. */
  async toolCount(roomId: string, serverId: string): Promise<number | undefined> {
    const listed = this.listed.get(RoomServers.key(roomId, serverId));
    return listed?.then((tools) => tools.length).catch(() => undefined);
  }

  /** The server's tools, read once and kept until it changes. Throws, saying why, when unreachable. */
  async tools(roomId: string, server: RoomServer): Promise<Tool[]> {
    const key = this.use(roomId, server);
    let listed = this.listed.get(key);
    if (listed === undefined) {
      listed = this.pool.listTools(key);
      this.listed.set(key, listed);
      listed.catch(() => {
        if (this.listed.get(key) === listed) this.listed.delete(key);
      });
    }
    try {
      const tools = await listed;
      this.problems.delete(key);
      return tools;
    } catch (error) {
      throw this.failed(key, server, error);
    }
  }

  /** Calls a tool, with the keys' values scrubbed from what comes back. */
  async call(
    roomId: string,
    server: RoomServer,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const key = this.use(roomId, server);
    try {
      const result = await this.pool.callTool(key, tool, args);
      this.problems.delete(key);
      const values = server.keys.map((k) => this.value(roomId, server, k));
      return {
        ...result,
        content: result.content.map((part) =>
          part.type === "text" ? { ...part, text: scrubSecrets(part.text, values) } : part,
        ),
      };
    } catch (error) {
      throw this.failed(key, server, error);
    }
  }

  /** Drops the connection and the tool list, so the next use sees the server's config as it is. */
  changed(roomId: string, serverId: string): void {
    const key = RoomServers.key(roomId, serverId);
    this.pool.forget(key);
    this.listed.delete(key);
    this.problems.delete(key);
  }

  /** Forgets a removed server, with its keys and sign-in. */
  removed(roomId: string, serverId: string): void {
    this.changed(roomId, serverId);
    this.known.delete(RoomServers.key(roomId, serverId));
    for (const name of this.secrets.names(roomId))
      if (name.startsWith(`${serverId}/`)) this.secrets.delete(roomId, name);
    this.logins.signOut(roomId, serverId);
  }

  private use(roomId: string, server: RoomServer): string {
    const key = RoomServers.key(roomId, server.id);
    const before = this.known.get(key)?.server;
    // A server changed by its record, such as its approval, keeps its connection.
    if (before !== undefined && JSON.stringify(reach(before)) !== JSON.stringify(reach(server)))
      this.changed(roomId, server.id);
    this.known.set(key, { roomId, server });
    const missing = this.missingKeys(roomId, server);
    if (missing.length > 0) {
      const names = missing.map((k) => k.name).join(", ");
      const problem = `${server.name} needs ${names} set on ${PANEL} first`;
      this.problems.set(key, problem);
      throw new Error(problem);
    }
    return key;
  }

  private failed(key: string, server: RoomServer, error: unknown): Error {
    const needsAuth =
      error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError;
    const problem = !needsAuth
      ? `${server.name}: ${(error as Error).message}`
      : server.keys.some((k) => k.in === "header")
        ? `${server.name} refused its key; someone can set it again on ${PANEL}`
        : `${server.name} needs someone in the room to sign in to it on ${PANEL}`;
    this.problems.set(key, problem);
    return new Error(problem);
  }

  private value(roomId: string, server: RoomServer, key: ServerKey): string | undefined {
    return this.secrets.get(roomId, keySecret(server.id, key));
  }
}

/** What decides how a server is reached. */
function reach(server: RoomServer) {
  const { url, command, args, headers, env, keys } = server;
  return { url, command, args, headers, env, keys };
}
