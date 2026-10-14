import { useEffect, useState, useSyncExternalStore } from "react";
import { tokenFor } from "./api.ts";

/** What every extension panel sends besides its own frames. */
type Common =
  | { type: "ready" }
  | { type: "ok"; ref?: string }
  | { type: "error"; message: string; ref?: string };

export type PanelSocketState<V> = {
  readonly status: "connecting" | "open" | "closed";
  /** The latest view the extension sent, once it has. */
  readonly view?: V;
  /** The last refusal, until the next change goes through. */
  readonly error?: string;
  /** 4401 bad token, 4404 no such room or extension here. */
  readonly closeCode?: number;
};

/**
 * One room's socket to an extension's panel (`/ext/<extension>`): hello with the token, then the
 * extension's frames. `view` picks the frame that carries the view; replies to an input with a
 * `ref` reach the promise `request` returned.
 */
export class PanelSocket<V, I extends object, F extends { type: string }> {
  private state: PanelSocketState<V> = { status: "connecting" };
  private readonly listeners = new Set<() => void>();
  private readonly socket: WebSocket;
  private readonly waiting = new Map<string, (frame: F | Common) => void>();
  private next = 0;

  constructor(
    assistant: string,
    room: string,
    extension: string,
    token: string,
    private readonly view: (frame: F) => V | undefined,
  ) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const path = `/v1/a/${encodeURIComponent(assistant)}/rooms/${encodeURIComponent(room)}/ext/${extension}`;
    this.socket = new WebSocket(`${scheme}://${location.host}${path}`);
    this.socket.addEventListener("open", () =>
      this.socket.send(JSON.stringify({ type: "hello", token })),
    );
    this.socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as F | Common;
      const ref = "ref" in frame && typeof frame.ref === "string" ? frame.ref : undefined;
      if (ref !== undefined) {
        this.waiting.get(ref)?.(frame);
        this.waiting.delete(ref);
      }
      if (frame.type === "ready") return this.update({ status: "open" });
      if (frame.type === "ok") return this.update({ error: undefined });
      if (frame.type === "error")
        return this.update({ error: (frame as { message: string }).message });
      const view = this.view(frame as F);
      if (view !== undefined) this.update({ view });
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

  readonly getState = (): PanelSocketState<V> => this.state;

  send(input: I): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(input));
  }

  /** Sends an input and waits for the frame that answers it. */
  request(input: I): Promise<F | Common> {
    const ref = `r${++this.next}`;
    return new Promise((resolve) => {
      this.waiting.set(ref, resolve);
      this.send({ ...input, ref });
    });
  }

  close(): void {
    this.socket.close();
  }

  private update(change: Partial<PanelSocketState<V>>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}

const CONNECTING = { status: "connecting" } as const;

/** Holds a room's panel socket to `extension` while mounted, and its state. */
export function usePanelSocket<V, I extends object, F extends { type: string }>(
  assistant: string,
  room: string,
  extension: string,
  view: (frame: F) => V | undefined,
): [PanelSocket<V, I, F> | undefined, PanelSocketState<V>] {
  const [socket, setSocket] = useState<PanelSocket<V, I, F>>();
  useEffect(() => {
    const token = tokenFor(assistant);
    if (token === undefined) return;
    const next = new PanelSocket<V, I, F>(assistant, room, extension, token, view);
    setSocket(next);
    return () => next.close();
    // `view` is a pure picker; a new one each render changes nothing.
  }, [assistant, room, extension]);
  const state = useSyncExternalStore(
    socket?.subscribe ?? (() => () => {}),
    socket?.getState ?? (() => CONNECTING),
  );
  return [socket, state];
}
