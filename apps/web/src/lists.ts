import { useEffect, useState, useSyncExternalStore } from "react";
import { tokenFor } from "./api.ts";

/** An item as the panel shows it (`Item` in `@nudge/ext-lists`). */
export type ListItem = { id: string; text: string; done: boolean; by: string; at: number };
export type PanelList = { name: string; items: ListItem[] };

export type ListsInput =
  | { type: "add"; list: string; text: string }
  | { type: "toggle"; list: string; id: string }
  | { type: "remove"; list: string; id: string }
  | { type: "clearDone"; list: string }
  | { type: "deleteList"; list: string };

type Output =
  | { type: "ready" }
  | { type: "lists"; lists: PanelList[] }
  | { type: "ok" }
  | { type: "error"; message: string };

export type ListsState = {
  readonly status: "connecting" | "open" | "closed";
  readonly lists?: PanelList[];
  readonly error?: string;
  /** 4401 bad token, 4404 no such room or no lists extension. */
  readonly closeCode?: number;
};

/** One room's lists panel, kept current by the server. */
export class ListsSocket {
  private state: ListsState = { status: "connecting" };
  private readonly listeners = new Set<() => void>();
  private readonly socket: WebSocket;

  constructor(assistant: string, room: string, token: string) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const path = `/v1/a/${encodeURIComponent(assistant)}/rooms/${encodeURIComponent(room)}/ext/lists`;
    this.socket = new WebSocket(`${scheme}://${location.host}${path}`);
    this.socket.addEventListener("open", () =>
      this.socket.send(JSON.stringify({ type: "hello", token })),
    );
    this.socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Output;
      if (frame.type === "ready") this.update({ status: "open" });
      else if (frame.type === "lists") this.update({ lists: frame.lists });
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

  readonly getState = (): ListsState => this.state;

  send(input: ListsInput): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(input));
  }

  close(): void {
    this.socket.close();
  }

  private update(change: Partial<ListsState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}

const CONNECTING: ListsState = { status: "connecting" };

export function useLists(assistant: string, room: string): [ListsSocket | undefined, ListsState] {
  const [socket, setSocket] = useState<ListsSocket>();
  useEffect(() => {
    const token = tokenFor(assistant);
    if (token === undefined) return;
    const next = new ListsSocket(assistant, room, token);
    setSocket(next);
    return () => next.close();
  }, [assistant, room]);
  const state = useSyncExternalStore(
    socket?.subscribe ?? (() => () => {}),
    socket?.getState ?? (() => CONNECTING),
  );
  return [socket, state];
}
