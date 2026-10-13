import type { ClientFrame, ServerFrame, WhenBusy } from "@nudge/server";
import { useEffect, useState, useSyncExternalStore } from "react";
import { tokenFor } from "./api.ts";
import { type ConversationView, ViewMirror } from "./mirror.ts";

export type RoomState = {
  readonly status: "connecting" | "open" | "closed";
  /** The room's conversation view, once the server sent it. */
  readonly view?: ConversationView;
  /** Why the socket closed: 4401 bad token, 4404 no such room, 1001 the assistant shut down. */
  readonly closeCode?: number;
  readonly error?: string;
};

/** The `?format=view` stream of one room: its view mirrored, and messages and stops sent. */
export class RoomSocket {
  private state: RoomState = { status: "connecting" };
  private readonly mirror = new ViewMirror();
  private readonly listeners = new Set<() => void>();
  private readonly waiting = new Map<
    string,
    { resolve: (submissionId: number) => void; reject: (error: Error) => void }
  >();
  private readonly socket: WebSocket;
  private sent = 0;

  constructor(assistant: string, room: string, token: string) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const path = `/a/${encodeURIComponent(assistant)}/rooms/${encodeURIComponent(room)}/stream`;
    this.socket = new WebSocket(`${scheme}://${location.host}${path}?format=view`);
    this.socket.addEventListener("open", () => this.send({ type: "hello", token }));
    this.socket.addEventListener("message", (event) =>
      this.receive(JSON.parse(String(event.data)) as ServerFrame),
    );
    this.socket.addEventListener("close", (event) => {
      for (const { reject } of this.waiting.values()) reject(new Error("The room closed"));
      this.waiting.clear();
      this.update({
        status: "closed",
        closeCode: event.code,
        ...(event.reason === "" ? {} : { error: event.reason }),
      });
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): RoomState => this.state;

  /** Posts a message; resolves with its submission id once the server took it. */
  submit(text: string, whenBusy?: WhenBusy): Promise<number> {
    const requestId = `${Date.now().toString(36)}-${++this.sent}`;
    return new Promise((resolve, reject) => {
      this.waiting.set(requestId, { resolve, reject });
      this.send({ type: "submit", text, requestId, ...(whenBusy ? { whenBusy } : {}) });
    });
  }

  /** Stops the answer in progress, and drops the room's queued messages. */
  abort(): void {
    this.send({ type: "abort" });
  }

  close(): void {
    this.socket.close();
  }

  private receive(frame: ServerFrame): void {
    switch (frame.type) {
      case "view":
      case "ops":
        if (this.mirror.receive(frame))
          this.update({ ...this.state, status: "open", view: this.mirror.value });
        return;
      case "submitted":
        this.settle(frame.requestId, (waiter) => waiter.resolve(frame.submissionId));
        return;
      case "error":
        if (frame.requestId === undefined) this.update({ ...this.state, error: frame.message });
        else this.settle(frame.requestId, (waiter) => waiter.reject(new Error(frame.message)));
        return;
    }
  }

  private settle(
    requestId: string | undefined,
    act: (waiter: { resolve: (id: number) => void; reject: (error: Error) => void }) => void,
  ): void {
    const waiter = requestId === undefined ? undefined : this.waiting.get(requestId);
    if (waiter === undefined) return;
    this.waiting.delete(requestId!);
    act(waiter);
  }

  private send(frame: ClientFrame): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private update(state: RoomState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

/** Close codes worth giving up on instead of reconnecting: the token or the room is simply bad. */
const NO_RETRY = new Set([4401, 4404]);
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Opens the room's stream while the component is mounted; undefined without a token. A close that
 * isn't `NO_RETRY` reopens a fresh socket (a fresh mirror, same as any reconnect) after a backoff
 * that doubles on each consecutive failure, reset once a socket reaches `open`.
 */
export function useRoomSocket(
  assistant: string,
  room: string,
): { readonly socket?: RoomSocket; readonly retrying: boolean } {
  const [socket, setSocket] = useState<RoomSocket>();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const token = tokenFor(assistant);
    if (token === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      setRetrying(false);
      const opened = new RoomSocket(assistant, room, token);
      setSocket(opened);
      const onChange = () => {
        const current = opened.getState();
        if (current.status === "open") {
          attempt = 0;
          return;
        }
        if (current.status !== "closed" || stopped || NO_RETRY.has(current.closeCode ?? -1)) return;
        unsubscribe();
        setRetrying(true);
        timer = setTimeout(connect, Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_MAX_MS));
        attempt += 1;
      };
      const unsubscribe = opened.subscribe(onChange);
    };
    connect();

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      setSocket((current) => {
        current?.close();
        return undefined;
      });
    };
  }, [assistant, room]);

  return { socket, retrying };
}

const CONNECTING: RoomState = { status: "connecting" };

/** The socket's state, re-rendering on every change. */
export function useRoomState(socket: RoomSocket | undefined): RoomState {
  return useSyncExternalStore(
    socket?.subscribe ?? noSubscription,
    socket?.getState ?? (() => CONNECTING),
  );
}

const noSubscription = () => () => {};
