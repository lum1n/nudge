import { useEffect, useState, useSyncExternalStore } from "react";
import { tokenFor } from "./api.ts";

/** What the desktop extension's live view sends (`LiveOutput` in `@nudge/ext-desktop`). */
type DesktopFrame =
  | { type: "ready" }
  | {
      type: "frame";
      data: string;
      x: number;
      y: number;
      width: number;
      height: number;
      screen: { width: number; height: number };
    }
  | { type: "windows"; windows: DesktopWindow[] }
  | { type: "apps"; apps: string[] }
  | { type: "status"; text: string }
  | { type: "error"; message: string }
  | { type: "control"; holder?: string; you: boolean };

export type DesktopWindow = { ref: string; title: string; app: string };

/** What it takes (`LiveInput`). Coordinates are screen pixels. */
export type DesktopInput =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean }
  | { type: "move"; x: number; y: number }
  | { type: "drag"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  | { type: "launch"; app: string }
  | { type: "raise"; ref: string }
  | { type: "take" };

export type DesktopState = {
  readonly status: "connecting" | "open" | "closed";
  /** The screen's size, once the first frame came. */
  readonly screen?: { width: number; height: number };
  readonly windows?: DesktopWindow[];
  readonly apps?: string[];
  /** What the desktop agent is doing now, if it works. */
  readonly working?: string;
  readonly error?: string;
  /** Who drives the desktop; the others watch. */
  readonly control?: { holder?: string; you: boolean };
  /** 4401 bad token, 4404 no such room or no desktop extension. */
  readonly closeCode?: number;
};

/** Keys with names, as the desktop takes them; F keys too (F2 renames in file managers). */
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
  "Insert",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

/** A keydown as desktop input: printable characters as text, the rest as key combos. */
export function desktopKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): DesktopInput | undefined {
  const modifiers = [
    event.ctrlKey || event.metaKey ? "ctrl" : "",
    event.altKey ? "alt" : "",
    event.shiftKey && (event.key.length !== 1 || event.ctrlKey || event.altKey) ? "shift" : "",
  ].filter(Boolean);
  const named = NAMED_KEYS.has(event.key);
  if (!named && event.key.length !== 1) return undefined;
  if (!named && modifiers.length === 0) return { type: "text", text: event.key };
  const key = named ? event.key : event.key.toLowerCase();
  return { type: "key", key: [...modifiers, key].join("+") };
}

/**
 * One viewer of a room's desktop. Frames are drawn on its own `canvas` as they come, in order,
 * also before the page shows it: each is only the part that changed.
 */
export class DesktopSocket {
  private state: DesktopState = { status: "connecting" };
  private readonly listeners = new Set<() => void>();
  private readonly socket: WebSocket;
  readonly canvas = document.createElement("canvas");
  private drawing = Promise.resolve();

  constructor(assistant: string, room: string, token: string) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const path = `/v1/a/${encodeURIComponent(assistant)}/rooms/${encodeURIComponent(room)}/ext/desktop`;
    this.socket = new WebSocket(`${scheme}://${location.host}${path}`);
    this.socket.addEventListener("open", () =>
      this.socket.send(JSON.stringify({ type: "hello", token })),
    );
    this.socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as DesktopFrame;
      if (frame.type === "ready") this.update({ status: "open" });
      else if (frame.type === "frame") this.draw(frame);
      else if (frame.type === "windows") this.update({ windows: frame.windows });
      else if (frame.type === "apps") this.update({ apps: frame.apps });
      else if (frame.type === "status") this.update({ working: frame.text || undefined });
      else if (frame.type === "control")
        this.update({ control: { holder: frame.holder, you: frame.you }, error: undefined });
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

  readonly getState = (): DesktopState => this.state;

  send(input: DesktopInput): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(input));
  }

  close(): void {
    this.socket.close();
  }

  /** Draws a changed part of the screen over the last, after the ones before it. */
  private draw(frame: Extract<DesktopFrame, { type: "frame" }>): void {
    const { screen } = this.state;
    if (screen?.width !== frame.screen.width || screen.height !== frame.screen.height)
      this.update({ screen: frame.screen });
    const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
    const decoded = createImageBitmap(new Blob([bytes], { type: "image/png" }));
    this.drawing = this.drawing.then(async () => {
      const image = await decoded.catch(() => undefined);
      const canvas = this.canvas;
      if (image === undefined) return;
      if (canvas.width !== frame.screen.width) canvas.width = frame.screen.width;
      if (canvas.height !== frame.screen.height) canvas.height = frame.screen.height;
      canvas.getContext("2d")?.drawImage(image, frame.x, frame.y);
      image.close();
    });
  }

  private update(change: Partial<DesktopState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}

export function useDesktopView(assistant: string, room: string): DesktopSocket | undefined {
  const [socket, setSocket] = useState<DesktopSocket>();
  useEffect(() => {
    const token = tokenFor(assistant);
    if (token === undefined) return;
    const next = new DesktopSocket(assistant, room, token);
    setSocket(next);
    return () => next.close();
  }, [assistant, room]);
  return socket;
}

const CONNECTING: DesktopState = { status: "connecting" };

export function useDesktopState(socket: DesktopSocket | undefined): DesktopState {
  return useSyncExternalStore(
    socket?.subscribe ?? (() => () => {}),
    socket?.getState ?? (() => CONNECTING),
  );
}
