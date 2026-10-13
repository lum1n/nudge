import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import {
  type Author,
  canUse,
  findAssistant,
  loadConfig,
  type Nudge,
  openAssistant,
  type Room,
} from "@nudge/core";
import type {
  ClientFrame,
  MeResponse,
  ProtectResponse,
  RoomResponse,
  ServerFrame,
} from "@nudge/server";
import { UsageError } from "./errors.ts";
import { hostOptions } from "./host.ts";

/** One client in one room, in this process or over the network. */
export interface ChatSession {
  readonly assistantName: string;
  readonly clientId: string;
  readonly room: Room;
  /** Resolves with the room so far; `listener` then gets every later batch. */
  attach(listener: (events: readonly AgentEvent[]) => void): Promise<SnapshotEvent>;
  submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
  abort(): Promise<void>;
  protect(value: string): Promise<string>;
  members(): Promise<string[]>;
  close(): Promise<void>;
}

export type ChatTarget = {
  /** Room id; `me` is the player's personal room. Default: the lobby. */
  readonly room?: string;
  /** What went wrong after the session started, such as an unanswered message. */
  readonly onProblem: (message: string) => void;
};

export type LocalTarget = ChatTarget & {
  readonly config: string;
  readonly assistant?: string;
  /** Player to chat as; default `owner`, created on first use. */
  readonly player?: string;
  /** Display name; default: the player's, or the user name for `owner`. */
  readonly name?: string;
  readonly defaultName: string;
};

export type RemoteTarget = ChatTarget & {
  /** `http(s)://host:port/a/<assistant>` */
  readonly url: string;
  readonly token: string;
};

const context = BACKGROUND_CONTEXT;

/** Opens the assistant in this process. Nothing else may have its database open. */
export async function openLocal(target: LocalTarget): Promise<ChatSession> {
  const config = await loadConfig(target.config);
  const assistant = findAssistant(config, target.assistant);
  const nudge = await openAssistant(config, assistant, context, hostOptions(assistant));
  try {
    const playerId = target.player ?? "owner";
    const known = await nudge.players.get(playerId, context);
    if (known === undefined && target.player !== undefined)
      throw new UsageError(`No player "${playerId}"; add one with: nudge invite <name>`);
    const player =
      target.name !== undefined || known === undefined
        ? await nudge.players.ensure(playerId, target.name ?? target.defaultName, context)
        : known;
    const room = await resolveLocalRoom(nudge, player.id, target.room);
    return new LocalSession(
      nudge,
      nudge.displayName,
      { playerId: player.id, displayName: player.displayName, clientId: `cli-${randomUUID()}` },
      room,
      target.onProblem,
    );
  } catch (error) {
    await nudge.close(context);
    throw error;
  }
}

async function resolveLocalRoom(nudge: Nudge, playerId: string, id = "lobby"): Promise<Room> {
  if (id === "me") return nudge.rooms.ensurePersonal(playerId, context);
  const room = await nudge.rooms.get(id, context);
  if (room === undefined || !canUse(room, playerId)) throw new UsageError(`No room "${id}"`);
  return room;
}

class LocalSession implements ChatSession {
  readonly clientId: string;
  private stream: Awaited<ReturnType<Nudge["attach"]>> | undefined;

  constructor(
    private readonly nudge: Nudge,
    readonly assistantName: string,
    private readonly author: Author & { clientId: string },
    readonly room: Room,
    private readonly onProblem: (message: string) => void,
  ) {
    this.clientId = author.clientId;
  }

  async attach(listener: (events: readonly AgentEvent[]) => void): Promise<SnapshotEvent> {
    this.stream = await this.nudge.attach(this.room.id, context);
    this.stream.start(async (events) => listener(events));
    return this.stream.snapshot;
  }

  async submit(text: string, whenBusy: "steer" | "followUp"): Promise<void> {
    const submission = await this.nudge.submit(
      this.room.id,
      { text, author: this.author, requestId: `${this.clientId}:${randomUUID()}`, whenBusy },
      context,
    );
    void submission.wait(context).then(
      (settled) => {
        if (settled.status === "unanswered")
          this.onProblem(`not answered: ${settled.reason}${describe(settled.detail)}`);
      },
      () => {},
    );
  }

  abort(): Promise<void> {
    return this.nudge.abort(this.room.id, context);
  }

  protect(value: string): Promise<string> {
    return this.nudge.protect(value);
  }

  async members(): Promise<string[]> {
    return (await this.nudge.rooms.members(this.room.id, context)).map((p) => p.displayName);
  }

  async close(): Promise<void> {
    await this.stream?.stop();
    await this.nudge.close(context);
  }
}

/** Talks to `nudge serve`. */
export async function openRemote(target: RemoteTarget): Promise<ChatSession> {
  const base = target.url.replace(/\/+$/, "");
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new UsageError(`${base}${path}: ${body.error ?? response.statusText}`);
    return body;
  };
  const me = await call<MeResponse>("/me");
  const room =
    target.room === "me"
      ? await call<Room>("/rooms/personal", { method: "POST", body: "{}" })
      : (await call<RoomResponse>(`/rooms/${encodeURIComponent(target.room ?? "lobby")}`)).room;
  return new RemoteSession(base, target.token, me, room, call, target.onProblem);
}

class RemoteSession implements ChatSession {
  readonly assistantName: string;
  readonly clientId: string;
  private socket: WebSocket | undefined;
  private closing = false;

  constructor(
    private readonly base: string,
    private readonly token: string,
    me: MeResponse,
    readonly room: Room,
    private readonly call: <T>(path: string, init?: RequestInit) => Promise<T>,
    private readonly onProblem: (message: string) => void,
  ) {
    this.assistantName = me.assistant.displayName;
    this.clientId = me.clientId;
  }

  attach(listener: (events: readonly AgentEvent[]) => void): Promise<SnapshotEvent> {
    const url = `${this.base.replace(/^http/, "ws")}/rooms/${encodeURIComponent(this.room.id)}/stream`;
    const socket = new WebSocket(url);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let attached = false;
      socket.addEventListener("open", () =>
        this.send({ type: "hello", token: this.token } satisfies ClientFrame),
      );
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as ServerFrame;
        if (frame.type === "snapshot" && !attached) {
          attached = true;
          resolve(frame);
        } else if (frame.type === "events") listener(frame.events);
        else if (frame.type === "error") this.onProblem(frame.message);
      });
      socket.addEventListener("close", (event) => {
        if (!attached) reject(new Error(`Could not join: ${event.reason || event.code}`));
        else if (!this.closing) this.onProblem(`disconnected (${event.reason || event.code})`);
      });
      socket.addEventListener("error", () => {
        if (!attached) reject(new Error(`Could not connect to ${url}`));
      });
    });
  }

  async submit(text: string, whenBusy: "steer" | "followUp"): Promise<void> {
    this.send({ type: "submit", text, whenBusy, requestId: randomUUID() });
  }

  async abort(): Promise<void> {
    this.send({ type: "abort" });
  }

  async protect(value: string): Promise<string> {
    const body = JSON.stringify({ value });
    return (await this.call<ProtectResponse>("/protect", { method: "POST", body })).placeholder;
  }

  async members(): Promise<string[]> {
    const { members } = await this.call<RoomResponse>(`/rooms/${encodeURIComponent(this.room.id)}`);
    return members.map((p) => p.displayName);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.socket?.close();
  }

  private send(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
    else this.onProblem("not connected");
  }
}

function describe(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  return ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`;
}
