import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ApiError, listAssistants, memoryTokens, NudgeClient } from "@nudge/client";
import {
  type Author,
  canUse,
  findAssistant,
  loadConfig,
  type Nudge,
  openAssistant,
  type Room as CoreRoom,
} from "@nudge/core";
import type { Approval, Fact, RoomView } from "@nudge/protocol";
import { toApproval, toFact } from "@nudge/protocol/project";
import { Hubs } from "@nudge/server";
import { UsageError } from "./errors.ts";
import { hostOptions, reloadOnHangup } from "./host.ts";

/**
 * One client in one room, in this process or over the network. Both give the room's protocol v1
 * view, so a chat renders the same either way.
 */
export interface ChatSession {
  readonly assistantName: string;
  readonly clientId: string;
  /** Resolves with the room's view now; `listener` then gets every later one. */
  watch(listener: (view: RoomView) => void): Promise<RoomView>;
  send(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
  abort(): Promise<void>;
  protect(value: string): Promise<string>;
  cancelNudge(id: string): Promise<void>;
  remember(text: string): Promise<Fact>;
  forget(id: string): Promise<void>;
  /** Approves or denies one; an approved action runs before this resolves. */
  decide(id: string, approve: boolean): Promise<Approval>;
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
  /** `http(s)://host:port`, or the older `http(s)://host:port/a/<assistant>`. */
  readonly url: string;
  /** Default: the one in `url`, or the server's first. */
  readonly assistant?: string;
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
    // `nudge reload` signals whoever holds the database: here, this process.
    const stopReloading = reloadOnHangup(
      target.config,
      new Map([[assistant.name, nudge]]),
      target.onProblem,
    );
    return new LocalSession(
      nudge,
      { playerId: player.id, displayName: player.displayName, clientId: `cli-${randomUUID()}` },
      room,
      target.onProblem,
      stopReloading,
    );
  } catch (error) {
    await nudge.close(context);
    throw error;
  }
}

async function resolveLocalRoom(nudge: Nudge, playerId: string, id = "lobby"): Promise<CoreRoom> {
  if (id === "me") return nudge.rooms.ensurePersonal(playerId, context);
  const room = await nudge.rooms.get(id, context);
  if (room === undefined || !canUse(room, playerId)) throw new UsageError(`No room "${id}"`);
  return room;
}

/** The room's view from a `RoomHub` in this process, as the server would send it. */
class LocalSession implements ChatSession {
  readonly assistantName: string;
  readonly clientId: string;
  private readonly hubs: Hubs;
  private stop: (() => void) | undefined;

  constructor(
    private readonly nudge: Nudge,
    private readonly author: Author & { clientId: string },
    private readonly room: CoreRoom,
    private readonly onProblem: (message: string) => void,
    private readonly stopReloading: () => void,
  ) {
    this.assistantName = nudge.displayName;
    this.clientId = author.clientId;
    this.hubs = new Hubs(nudge, (error) => onProblem((error as Error).message));
  }

  async watch(listener: (view: RoomView) => void): Promise<RoomView> {
    const lease = await this.hubs.room(this.room.id);
    if (lease === undefined) throw new UsageError(`No room "${this.room.id}"`);
    const { hub } = lease;
    const unlisten = hub.listen({
      changed: () => listener(hub.view()),
      ended: (reason) =>
        this.onProblem(reason === "gone" ? "this room is gone" : "the assistant shut down"),
    });
    this.stop = () => {
      unlisten();
      lease.release();
    };
    return hub.view();
  }

  async send(text: string, whenBusy: "steer" | "followUp"): Promise<void> {
    const submission = await this.nudge.submit(
      this.room.id,
      { text, author: this.author, requestId: randomUUID(), whenBusy },
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

  async cancelNudge(id: string): Promise<void> {
    const nudge = await this.nudge.nudges.get(id, context);
    if (nudge?.roomId !== this.room.id || !(await this.nudge.nudges.cancel(id, context)))
      throw new UsageError(`No nudge ${id} here`);
  }

  async remember(text: string): Promise<Fact> {
    return toFact(await this.nudge.memory.remember(this.room.id, text, context));
  }

  async forget(id: string): Promise<void> {
    if (!(await this.nudge.memory.forget(this.room.id, id, context)))
      throw new UsageError(`No fact ${id} here`);
  }

  async decide(id: string, approve: boolean): Promise<Approval> {
    const by = { playerId: this.author.playerId, displayName: this.author.displayName };
    return toApproval(
      await this.nudge.approvals.decide(this.room.id, id, { approve, by }, context),
    );
  }

  async close(): Promise<void> {
    this.stop?.();
    this.stopReloading();
    await this.nudge.close(context);
  }
}

const CLIENT = { name: "nudge-cli", version: "0.0.0", platform: process.platform };

/** Talks to `nudge serve` over protocol v1. */
export async function openRemote(target: RemoteTarget): Promise<ChatSession> {
  const { server, assistant } = await resolveServer(target.url, target.assistant);
  const client = new NudgeClient({
    server,
    assistant: assistant.name,
    tokens: memoryTokens(target.token),
    client: CLIENT,
    onError: target.onProblem,
  });
  try {
    const me = await client.api.me();
    const room =
      target.room === "me" ? (await client.api.personalRoom()).id : (target.room ?? "lobby");
    return new RemoteSession(client, assistant.displayName, me.clientId, room, target.onProblem);
  } catch (error) {
    if (error instanceof ApiError) throw new UsageError(`${server}: ${error.message}`);
    throw error;
  }
}

/** The server's base address and the assistant to talk to there. */
async function resolveServer(
  url: string,
  name: string | undefined,
): Promise<{ server: string; assistant: { name: string; displayName: string } }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`--url ${url} is not a URL`);
  }
  // Addresses from before protocol v1 named the assistant in the path.
  const old = /^(.*?)\/(?:v1\/)?a\/([^/]+)\/*$/.exec(parsed.pathname);
  const server = `${parsed.origin}${old?.[1] ?? parsed.pathname.replace(/\/+$/, "")}`;
  const wanted = name ?? (old?.[2] === undefined ? undefined : decodeURIComponent(old[2]));
  let assistants: { name: string; displayName: string }[];
  try {
    ({ assistants } = await listAssistants(server));
  } catch (error) {
    throw new UsageError(`Could not reach ${server}: ${(error as Error).message}`);
  }
  const assistant =
    wanted === undefined ? assistants[0] : assistants.find((a) => a.name === wanted);
  if (assistant === undefined)
    throw new UsageError(
      wanted === undefined
        ? `${server} hosts no assistants`
        : `${server} has no assistant "${wanted}"; it has: ${assistants.map((a) => a.name).join(", ")}`,
    );
  return { server, assistant };
}

/** A room's view through `@nudge/client`: one socket, resubscribed after every reconnect. */
class RemoteSession implements ChatSession {
  private stop: (() => void) | undefined;
  private closing = false;

  constructor(
    private readonly client: NudgeClient,
    readonly assistantName: string,
    readonly clientId: string,
    private readonly room: string,
    private readonly onProblem: (message: string) => void,
  ) {}

  watch(listener: (view: RoomView) => void): Promise<RoomView> {
    const { client } = this;
    const lease = client.room(this.room);
    const { store } = lease;
    client.open();
    return new Promise((resolve, reject) => {
      let first: RoomView | undefined;
      let connected = false;
      const fail = (message: string) => {
        stopStore();
        stopConnection();
        lease.release();
        client.close();
        reject(new UsageError(message));
      };
      const stopStore = store.subscribe(() => {
        const state = store.getState();
        if (state.status === "gone") {
          if (first === undefined) return fail(`No room "${this.room}"`);
          this.onProblem(
            state.reason === "removed" ? "you were removed from this room" : "this room is gone",
          );
          return;
        }
        if (state.view === undefined) return;
        if (first === undefined) {
          first = state.view;
          resolve(first);
        } else listener(state.view);
      });
      const stopConnection = client.connection.subscribe(() => {
        const status = client.connection.getStatus();
        if (status.kind === "open") connected = true;
        else if (status.kind === "waiting" && connected) {
          connected = false;
          this.onProblem("disconnected; reconnecting…");
        } else if (status.kind === "closed" && !this.closing) {
          const why = `${status.reason || "closed"} (${status.code})`;
          if (first === undefined) fail(`Could not connect: ${why}`);
          else this.onProblem(`disconnected: ${why}`);
        }
      });
      this.stop = () => {
        stopStore();
        stopConnection();
        lease.release();
      };
    });
  }

  async send(text: string, whenBusy: "steer" | "followUp"): Promise<void> {
    await this.client.send(this.room, text, { whenBusy });
  }

  abort(): Promise<void> {
    return this.client.api.abort(this.room);
  }

  protect(value: string): Promise<string> {
    return this.client.api.protect(value);
  }

  async cancelNudge(id: string): Promise<void> {
    await this.notFound(this.client.api.cancelNudge(id), `No nudge ${id} here`);
  }

  remember(text: string): Promise<Fact> {
    return this.client.api.remember(this.room, text);
  }

  async forget(id: string): Promise<void> {
    await this.notFound(this.client.api.forget(this.room, id), `No fact ${id} here`);
  }

  decide(id: string, approve: boolean): Promise<Approval> {
    return this.client.api.decide(this.room, id, approve);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.stop?.();
    this.client.close();
  }

  private async notFound<T>(call: Promise<T>, message: string): Promise<T> {
    try {
      return await call;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new UsageError(message);
      throw error;
    }
  }
}

function describe(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  return ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`;
}
