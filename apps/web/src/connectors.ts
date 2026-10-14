import { useEffect, useState, useSyncExternalStore } from "react";
import { tokenFor } from "./api.ts";

/** A connector as the panel shows it (`PanelConnector` in `@nudge/ext-connectors`); never its key. */
export type PanelConnector = {
  id: string;
  name: string;
  baseUrl: string;
  useFor: string;
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
export type PanelInput =
  | { type: "setKey"; connector: string; value: string }
  | { type: "clearKey"; connector: string }
  | { type: "setPrivateNetwork"; connector: string; allow: boolean }
  | { type: "setReadPaths"; connector: string; readPaths: string[] }
  | { type: "remove"; connector: string };

type PanelOutput =
  | { type: "ready" }
  | { type: "connectors"; connectors: PanelConnector[] }
  | { type: "ok"; ref?: string }
  | { type: "error"; message: string; ref?: string };

export type PanelState = {
  readonly status: "connecting" | "open" | "closed";
  readonly connectors?: PanelConnector[];
  /** The last refusal, until the next change goes through. */
  readonly error?: string;
  /** 4401 bad token, 4404 no such room or no connectors extension. */
  readonly closeCode?: number;
};

/** One room's connectors panel. */
export class ConnectorsSocket {
  private state: PanelState = { status: "connecting" };
  private readonly listeners = new Set<() => void>();
  private readonly socket: WebSocket;

  constructor(assistant: string, room: string, token: string) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const path = `/v1/a/${encodeURIComponent(assistant)}/rooms/${encodeURIComponent(room)}/ext/connectors`;
    this.socket = new WebSocket(`${scheme}://${location.host}${path}`);
    this.socket.addEventListener("open", () =>
      this.socket.send(JSON.stringify({ type: "hello", token })),
    );
    this.socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as PanelOutput;
      if (frame.type === "ready") this.update({ status: "open" });
      else if (frame.type === "connectors") this.update({ connectors: frame.connectors });
      else if (frame.type === "ok") this.update({ error: undefined });
      else this.update({ error: frame.message });
    });
    this.socket.addEventListener("close", (event) =>
      this.update({
        status: "closed",
        closeCode: event.code,
        ...(event.reason ? { error: event.reason } : {}),
      }),
    );
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): PanelState => this.state;

  send(input: PanelInput): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(input));
  }

  close(): void {
    this.socket.close();
  }

  private update(change: Partial<PanelState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}

export function useConnectors(assistant: string, room: string): ConnectorsSocket | undefined {
  const [socket, setSocket] = useState<ConnectorsSocket>();
  useEffect(() => {
    const token = tokenFor(assistant);
    if (token === undefined) return;
    const next = new ConnectorsSocket(assistant, room, token);
    setSocket(next);
    return () => next.close();
  }, [assistant, room]);
  return socket;
}

const CONNECTING: PanelState = { status: "connecting" };

export function usePanelState(socket: ConnectorsSocket | undefined): PanelState {
  return useSyncExternalStore(
    socket?.subscribe ?? (() => () => {}),
    socket?.getState ?? (() => CONNECTING),
  );
}
