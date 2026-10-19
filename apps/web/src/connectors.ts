import { type PanelSocket, type PanelSocketState, usePanelSocket } from "./panel-socket.ts";

/** A connector as the panel shows it (`PanelConnector` in `@nudge/ext-connectors`); never its key. */
export type PanelConnector = {
  id: string;
  name: string;
  baseUrl: string;
  useFor: string;
  alwaysFirst?: boolean;
  docsUrl?: string;
  notes: string;
  auth?: { in: "header" | "query"; name: string; prefix?: string };
  allowPrivateNetwork: boolean;
  readPaths: string[];
  addedBy: string;
  shared: boolean;
  hasKey: boolean;
};

/** What the panel takes (`PanelInput`); sharing is for admins, from the CLI. */
export type ConnectorsInput =
  | { type: "setKey"; connector: string; value: string }
  | { type: "clearKey"; connector: string }
  | { type: "setPrivateNetwork"; connector: string; allow: boolean }
  | { type: "setReadPaths"; connector: string; readPaths: string[] }
  | { type: "setUseFor"; connector: string; useFor: string }
  | { type: "setAlwaysFirst"; connector: string; alwaysFirst: boolean }
  | { type: "remove"; connector: string };

type ConnectorsFrame = { type: "connectors"; connectors: PanelConnector[] };

export type ConnectorsSocket = PanelSocket<PanelConnector[], ConnectorsInput, ConnectorsFrame>;

/** One room's connectors, kept current by the server. */
export function useConnectors(
  assistant: string,
  room: string,
): [ConnectorsSocket | undefined, PanelSocketState<PanelConnector[]>] {
  return usePanelSocket<PanelConnector[], ConnectorsInput, ConnectorsFrame>(
    assistant,
    room,
    "connectors",
    (frame) => (frame.type === "connectors" ? frame.connectors : undefined),
  );
}
