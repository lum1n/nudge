import {
  BACKGROUND_CONTEXT,
  type ExtensionDocuments,
  type RoomSocketHandler,
  type SecretStore,
} from "@nudge/core";
import type { OAuthLogins } from "./oauth.ts";
import { keySecret, PANEL, type RoomServers } from "./room-servers.ts";
import {
  describeServer,
  type RoomServer,
  RoomServersDoc,
  removeServer,
  type ServerKey,
  updateServer,
} from "./rooms.ts";

/** A room's server as the panel shows it: whether each key is set, never its value. */
export type PanelServer = Omit<RoomServer, "keys"> & {
  /** The URL, or the command line. */
  readonly runs: string;
  readonly keys: (ServerKey & { readonly set: boolean })[];
  /** Remote servers only: whether someone signed in with OAuth. */
  readonly signedIn: boolean;
  /** What went wrong the last time it was used. */
  readonly problem?: string;
  /** How many tools it has, once they were read. */
  readonly tools?: number;
};

/** What the panel socket sends. `ref` echoes the input's. */
export type PanelOutput =
  | { type: "servers"; servers: PanelServer[] }
  | { type: "signIn"; url: string; ref?: string }
  | { type: "ok"; ref?: string }
  | { type: "error"; message: string; ref?: string };

/**
 * What it takes. Keys, sign-ins and which calls wait for approval are set here by people, never
 * by the model. `base` is the address the person's app reaches the server by, for the sign-in to
 * come back to.
 */
export type PanelInput = { ref?: string } & (
  | { type: "setKey"; server: string; key: string; value: string }
  | { type: "clearKey"; server: string; key: string }
  | { type: "setApproval"; server: string; approval: RoomServer["approval"] }
  | { type: "setTrustReadOnlyHint"; server: string; trust: boolean }
  | { type: "signIn"; server: string; base: string }
  | { type: "signOut"; server: string }
  | { type: "refresh"; server: string }
  | { type: "remove"; server: string }
);

const APPROVALS = new Set(["writes", "always", "never"]);

/** Serves the MCP panel of each room, and tells every open panel of a room when its servers change. */
export class Panels {
  private readonly viewers = new Map<string, Set<{ send(data: string): void }>>();

  constructor(
    private readonly documents: () => ExtensionDocuments,
    private readonly secrets: SecretStore,
    private readonly rooms: RoomServers,
    private readonly logins: OAuthLogins,
  ) {}

  async list(roomId: string): Promise<PanelServer[]> {
    const state = await this.documents().snapshot(RoomServersDoc, roomId, BACKGROUND_CONTEXT);
    return Promise.all(
      (state?.servers ?? []).map(async (stored): Promise<PanelServer> => {
        const server = JSON.parse(JSON.stringify(stored)) as RoomServer;
        // Said to the model with where to go; here, people are there already.
        const problem = this.rooms.problem(roomId, server.id)?.replace(` on ${PANEL}`, "");
        const tools = await this.rooms.toolCount(roomId, server.id);
        return {
          ...server,
          runs: describeServer(server),
          keys: server.keys.map((key) => ({
            ...key,
            set: this.rooms.hasValue(roomId, server, key),
          })),
          signedIn: server.url !== undefined && this.logins.signedIn(roomId, server.id),
          ...(problem === undefined ? {} : { problem }),
          ...(tools === undefined ? {} : { tools }),
        };
      }),
    );
  }

  /** Sends the room's servers to its open panels. Never fails. */
  async changed(roomId: string): Promise<void> {
    const viewers = this.viewers.get(roomId);
    if (viewers === undefined || viewers.size === 0) return;
    let servers: PanelServer[];
    try {
      servers = await this.list(roomId);
    } catch {
      return;
    }
    const frame = JSON.stringify({ type: "servers", servers } satisfies PanelOutput);
    for (const viewer of viewers) viewer.send(frame);
  }

  readonly roomSocket: RoomSocketHandler = async ({ room }, socket) => {
    const viewer = { send: (data: string) => socket.send(data) };
    const reply = (output: PanelOutput) => socket.send(JSON.stringify(output));
    let viewers = this.viewers.get(room.id);
    if (viewers === undefined) this.viewers.set(room.id, (viewers = new Set()));
    viewers.add(viewer);
    reply({ type: "servers", servers: await this.list(room.id) });
    // One input at a time, so replies and lists go out in order.
    let queue = Promise.resolve();
    return {
      receive: (data) => {
        queue = queue.then(async () => {
          let input: PanelInput;
          try {
            input = JSON.parse(data) as PanelInput;
          } catch {
            return reply({ type: "error", message: "Frames are JSON" });
          }
          const ref = typeof input.ref === "string" ? { ref: input.ref } : {};
          try {
            const url = await this.apply(room.id, input);
            reply(url === undefined ? { type: "ok", ...ref } : { type: "signIn", url, ...ref });
          } catch (error) {
            reply({ type: "error", message: (error as Error).message, ...ref });
          }
          await this.changed(room.id);
        });
      },
      close: () => {
        viewers.delete(viewer);
        if (viewers.size === 0) this.viewers.delete(room.id);
      },
    };
  };

  /** Applies one input; a sign-in's address to open, if any. */
  private async apply(roomId: string, input: PanelInput): Promise<string | undefined> {
    const documents = this.documents();
    if (typeof input.server !== "string") throw new Error("Say which server");
    const state = await documents.snapshot(RoomServersDoc, roomId, BACKGROUND_CONTEXT);
    const stored = state?.servers.find((s) => s.id === input.server);
    if (stored === undefined) throw new Error(`No MCP server "${input.server}" here`);
    const server = JSON.parse(JSON.stringify(stored)) as RoomServer;
    const keyOf = (name: unknown) => {
      const key = server.keys.find((k) => k.name === name);
      if (key === undefined) throw new Error(`${server.name} has no key "${String(name)}"`);
      return key;
    };
    switch (input.type) {
      case "setKey": {
        const key = keyOf(input.key);
        if (typeof input.value !== "string" || input.value.trim() === "")
          throw new Error("Give a value, or clear the key");
        this.secrets.set(roomId, keySecret(server.id, key), input.value.trim());
        this.rooms.changed(roomId, server.id);
        return undefined;
      }
      case "clearKey":
        this.secrets.delete(roomId, keySecret(server.id, keyOf(input.key)));
        this.rooms.changed(roomId, server.id);
        return undefined;
      case "setApproval":
        if (!APPROVALS.has(input.approval)) throw new Error("Approval is writes, always or never");
        await documents.commit(
          (tx) => updateServer(tx, roomId, server.id, { approval: input.approval }),
          BACKGROUND_CONTEXT,
        );
        return undefined;
      case "setTrustReadOnlyHint":
        if (typeof input.trust !== "boolean") throw new Error("Trust is true or false");
        await documents.commit(
          (tx) => updateServer(tx, roomId, server.id, { trustReadOnlyHint: input.trust }),
          BACKGROUND_CONTEXT,
        );
        return undefined;
      case "signIn": {
        if (server.url === undefined) throw new Error(`${server.name} is a program; it takes keys`);
        if (typeof input.base !== "string") throw new Error("Say the server's address");
        const started = await this.logins.start(roomId, server.id, server.url, input.base);
        this.rooms.changed(roomId, server.id);
        return started === "signedIn" ? undefined : started.url;
      }
      case "signOut":
        this.logins.signOut(roomId, server.id);
        this.rooms.changed(roomId, server.id);
        return undefined;
      case "refresh":
        this.rooms.changed(roomId, server.id);
        await this.rooms.tools(roomId, server);
        return undefined;
      case "remove":
        await documents.commit((tx) => removeServer(tx, roomId, server.id), BACKGROUND_CONTEXT);
        this.rooms.removed(roomId, server.id);
        return undefined;
      default:
        throw new Error(`Unknown input "${(input as { type?: unknown }).type}"`);
    }
  }
}
