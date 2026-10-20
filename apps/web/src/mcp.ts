import { type PanelSocket, type PanelSocketState, usePanelSocket } from "./panel-socket.ts";

/** A server the room added, as the panel shows it (`PanelServer` in `@nudge/ext-mcp`); never a key. */
export type PanelServer = {
  id: string;
  name: string;
  useFor: string;
  /** The URL, or the command line. */
  runs: string;
  url?: string;
  command?: string;
  keys: { in: "header" | "env"; name: string; prefix?: string; set: boolean }[];
  approval: "writes" | "always" | "never";
  addedBy: string;
  signedIn: boolean;
  problem?: string;
  tools?: number;
};

/** What the panel takes (`PanelInput`). */
export type McpInput =
  | { type: "setKey"; server: string; key: string; value: string }
  | { type: "clearKey"; server: string; key: string }
  | { type: "setApproval"; server: string; approval: PanelServer["approval"] }
  | { type: "signIn"; server: string; base: string }
  | { type: "signOut"; server: string }
  | { type: "refresh"; server: string }
  | { type: "remove"; server: string };

type McpFrame = { type: "servers"; servers: PanelServer[] } | { type: "signIn"; url: string };

export type McpSocket = PanelSocket<PanelServer[], McpInput, McpFrame>;

/** One room's MCP servers, kept current by the server. */
export function useMcpServers(
  assistant: string,
  room: string,
): [McpSocket | undefined, PanelSocketState<PanelServer[]>] {
  return usePanelSocket<PanelServer[], McpInput, McpFrame>(assistant, room, "mcp", (frame) =>
    frame.type === "servers" ? frame.servers : undefined,
  );
}
