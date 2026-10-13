import { useEffect, useState, useSyncExternalStore } from "react";
import { tokenFor } from "./api.ts";

/** What the browser extension's live view sends (`LiveOutput` in `@nudge/ext-browser`). */
export type LiveFrame =
  | { type: "ready" }
  | { type: "frame"; data: string; width: number; height: number; url: string }
  | { type: "done"; saved: string[] }
  | { type: "error"; message: string };

/** What it takes (`LiveInput`). Coordinates are page pixels. */
export type LiveInput =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string }
  | { type: "done"; remember: boolean };

export type LiveState = {
  readonly status: "connecting" | "open" | "closed";
  readonly frame?: { data: string; width: number; height: number; url: string };
  readonly saved?: string[];
  readonly error?: string;
  /** 4401 bad token, 4404 no such room or no browser extension. */
  readonly closeCode?: number;
};

const NAMED_KEYS = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

/** A keydown as live-view input: printable characters as text, the rest as Playwright key names. */
export function keyInput(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): LiveInput | undefined {
  const chord = event.ctrlKey || event.metaKey;
  if (chord) {
    if (event.key.length !== 1) return undefined;
    // Copy and paste in the page itself; the clipboard here is the viewer's.
    return { type: "key", key: `${event.ctrlKey ? "Control" : "Meta"}+${event.key.toUpperCase()}` };
  }
  if (event.key.length === 1 && !event.altKey) return { type: "text", text: event.key };
  if (NAMED_KEYS.has(event.key)) return { type: "key", key: event.key };
  return undefined;
}

/** One viewer of a room's browser. */
export class LiveSocket {
  private state: LiveState = { status: "connecting" };
  private readonly listeners = new Set<() => void>();
  private readonly socket: WebSocket;

  constructor(assistant: string, room: string, token: string) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const path = `/a/${encodeURIComponent(assistant)}/rooms/${encodeURIComponent(room)}/ext/browser`;
    this.socket = new WebSocket(`${scheme}://${location.host}${path}`);
    this.socket.addEventListener("open", () =>
      this.socket.send(JSON.stringify({ type: "hello", token })),
    );
    this.socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as LiveFrame;
      if (frame.type === "ready") this.update({ status: "open" });
      else if (frame.type === "frame") this.update({ frame });
      else if (frame.type === "done") this.update({ saved: frame.saved });
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

  readonly getState = (): LiveState => this.state;

  send(input: LiveInput): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(input));
  }

  close(): void {
    this.socket.close();
  }

  private update(change: Partial<LiveState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}

export function useLiveView(assistant: string, room: string): LiveSocket | undefined {
  const [socket, setSocket] = useState<LiveSocket>();
  useEffect(() => {
    const token = tokenFor(assistant);
    if (token === undefined) return;
    const next = new LiveSocket(assistant, room, token);
    setSocket(next);
    return () => next.close();
  }, [assistant, room]);
  return socket;
}

const CLOSED: LiveState = { status: "connecting" };

export function useLiveState(socket: LiveSocket | undefined): LiveState {
  return useSyncExternalStore(
    socket?.subscribe ?? (() => () => {}),
    socket?.getState ?? (() => CLOSED),
  );
}
