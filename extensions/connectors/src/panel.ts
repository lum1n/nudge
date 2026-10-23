import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExtensionDocuments, RoomSocketHandler, SecretStore } from "@nudge/core";
import {
  type Connector,
  ConnectorsDoc,
  removeConnector,
  SharedConnectorsDoc,
  shareConnector,
  unshareConnector,
  updateConnector,
} from "./model.ts";

/** A connector as the panel shows it: never its key, only whether it has one. */
export type PanelConnector = Connector & {
  /** Shared with every room; changed only by unsharing it. */
  readonly shared: boolean;
  readonly hasKey: boolean;
};

/** What the panel socket sends. `ref` echoes the input's. */
export type PanelOutput =
  | { type: "connectors"; connectors: PanelConnector[]; admin: boolean }
  | { type: "ok"; ref?: string }
  | { type: "error"; message: string; ref?: string };

/**
 * What it takes. Keys, the private network, `readPaths` and whether a connector comes first are
 * set here by people, never by the model; sharing with every room is for admins.
 */
export type PanelInput = { ref?: string } & (
  | { type: "setKey"; connector: string; value: string }
  | { type: "clearKey"; connector: string }
  | { type: "setPrivateNetwork"; connector: string; allow: boolean }
  | { type: "setReadPaths"; connector: string; readPaths: string[] }
  | { type: "setUseFor"; connector: string; useFor: string }
  | { type: "setAlwaysFirst"; connector: string; alwaysFirst: boolean }
  | { type: "remove"; connector: string }
  | { type: "share"; connector: string }
  | { type: "unshare"; connector: string }
);

const READ_PATH = /^(POST|PUT|PATCH|DELETE) \/\S*$/;

/**
 * Serves the connectors panel of each room, and tells every open panel of a room when its
 * connectors change, whoever changed them.
 */
export class Panels {
  private readonly viewers = new Map<string, Set<{ send(data: string): void; admin: boolean }>>();

  constructor(
    private readonly documents: () => ExtensionDocuments,
    private readonly secrets: SecretStore,
  ) {}

  /** The room's own connectors, then the shared ones. */
  async list(roomId: string, context: Context = BACKGROUND_CONTEXT): Promise<PanelConnector[]> {
    const documents = this.documents();
    const [own, shared] = await Promise.all([
      documents.snapshot(ConnectorsDoc, roomId, context),
      documents.snapshot(SharedConnectorsDoc, context),
    ]);
    const show = (connector: Readonly<Connector>, isShared: boolean): PanelConnector => ({
      ...(JSON.parse(JSON.stringify(connector)) as Connector),
      shared: isShared,
      hasKey: !isShared && this.secrets.get(roomId, connector.id) !== undefined,
    });
    return [
      ...(own?.connectors ?? []).map((c: Readonly<Connector>) => show(c, false)),
      ...(shared?.connectors ?? []).map((c: Readonly<Connector>) => show(c, true)),
    ];
  }

  /**
   * Sends the room's connectors to its open panels; with shared ones changed, to every room's.
   * Never fails: a panel that misses an update, as when the assistant is closing, gets the next.
   */
  async changed(roomId: string | "all"): Promise<void> {
    const rooms = roomId === "all" ? [...this.viewers.keys()] : [roomId];
    for (const room of rooms) {
      const viewers = this.viewers.get(room);
      if (viewers === undefined || viewers.size === 0) continue;
      let connectors: PanelConnector[];
      try {
        connectors = await this.list(room);
      } catch {
        continue;
      }
      for (const viewer of viewers)
        viewer.send(
          JSON.stringify({
            type: "connectors",
            connectors,
            admin: viewer.admin,
          } satisfies PanelOutput),
        );
    }
  }

  readonly roomSocket: RoomSocketHandler = async ({ room, admin }, socket) => {
    const viewer = {
      admin,
      send: (data: string) => socket.send(data),
    };
    const reply = (output: PanelOutput) => socket.send(JSON.stringify(output));
    let viewers = this.viewers.get(room.id);
    if (viewers === undefined) this.viewers.set(room.id, (viewers = new Set()));
    viewers.add(viewer);
    reply({ type: "connectors", connectors: await this.list(room.id), admin });
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
            const scope = await this.apply(room.id, admin, input);
            reply({ type: "ok", ...ref });
            await this.changed(scope);
          } catch (error) {
            reply({ type: "error", message: (error as Error).message, ...ref });
          }
        });
      },
      close: () => {
        viewers.delete(viewer);
        if (viewers.size === 0) this.viewers.delete(room.id);
      },
    };
  };

  /** Applies one input; says whose panels to update. */
  private async apply(roomId: string, admin: boolean, input: PanelInput): Promise<string> {
    const context = BACKGROUND_CONTEXT;
    const documents = this.documents();
    if (typeof input.connector !== "string") throw new Error("Say which connector");
    const id = input.connector;
    const own = async () => {
      const connector = (await this.list(roomId)).find((c) => c.id === id);
      if (connector === undefined || connector.shared)
        throw new Error(
          connector === undefined
            ? `No connector "${id}" here`
            : `${connector.name} is shared with every room; unshare it to change it`,
        );
      return connector;
    };
    switch (input.type) {
      case "setKey": {
        const connector = await own();
        if (connector.auth === undefined) throw new Error(`${connector.name} takes no API key`);
        const value = typeof input.value === "string" ? input.value.trim() : "";
        if (value === "") throw new Error("The key is empty");
        this.secrets.set(roomId, id, value);
        return roomId;
      }
      case "clearKey":
        await own();
        this.secrets.delete(roomId, id);
        return roomId;
      case "setPrivateNetwork":
        await own();
        await documents.commit(
          (tx) => updateConnector(tx, roomId, id, { allowPrivateNetwork: input.allow === true }),
          context,
        );
        return roomId;
      case "setReadPaths": {
        await own();
        const paths = Array.isArray(input.readPaths) ? input.readPaths : [];
        const readPaths = [
          ...new Set(paths.map((path) => String(path).trim().replace(/\s+/, " "))),
        ].filter((path) => path !== "");
        const wrong = readPaths.find((path) => !READ_PATH.test(path));
        if (wrong !== undefined)
          throw new Error(
            `"${wrong}" is not "METHOD /path" with POST, PUT, PATCH or DELETE (GET and HEAD are reads anyway)`,
          );
        await documents.commit((tx) => updateConnector(tx, roomId, id, { readPaths }), context);
        return roomId;
      }
      case "setUseFor": {
        await own();
        const useFor = typeof input.useFor === "string" ? input.useFor : "";
        await documents.commit((tx) => updateConnector(tx, roomId, id, { useFor }), context);
        return roomId;
      }
      case "setAlwaysFirst":
        await own();
        await documents.commit(
          (tx) => updateConnector(tx, roomId, id, { alwaysFirst: input.alwaysFirst === true }),
          context,
        );
        return roomId;
      case "remove":
        await own();
        await documents.commit((tx) => removeConnector(tx, roomId, id), context);
        this.secrets.delete(roomId, id);
        return roomId;
      case "share":
      case "unshare":
        if (!admin) throw new Error("Only an admin shares connectors with every room");
        await documents.commit(
          (tx) =>
            input.type === "share"
              ? shareConnector(tx, roomId, id)
              : unshareConnector(tx, roomId, id),
          context,
        );
        return "all";
      default:
        throw new Error(`Unknown input "${(input as { type?: unknown }).type}"`);
    }
  }
}
