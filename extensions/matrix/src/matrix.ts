import { randomBytes } from "node:crypto";
import type { Inbound, Transport } from "@nudge/bridge";

/** The parts of a `/sync` response the bridge reads. */
export type SyncResponse = {
  next_batch: string;
  rooms?: {
    join?: Record<
      string,
      {
        summary?: { "m.joined_member_count"?: number };
        timeline?: { events?: RoomEvent[] };
      }
    >;
    invite?: Record<string, unknown>;
  };
};

type RoomEvent = {
  type: string;
  event_id: string;
  sender: string;
  content?: { msgtype?: string; body?: string };
};

export class MatrixError extends Error {
  override name = "MatrixError";
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

const MAX_LENGTH = 4000;

/** The Matrix client-server API calls the bridge uses. Errors never carry the token. */
export class MatrixClient implements Transport {
  readonly name = "matrix";
  readonly maxLength = MAX_LENGTH;
  readonly buttons = false;
  /** Joined members per room, from `/sync` summaries; two means a direct chat. */
  private readonly members = new Map<string, number>();
  private userId: string | undefined;

  constructor(
    private readonly homeserver: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, path: string, body?: object, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.homeserver.replace(/\/+$/, "")}/_matrix/client/v3${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new MatrixError(`Matrix ${path.split("?")[0]}: ${(error as Error).message}`, undefined);
    }
    const reply = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok)
      throw new MatrixError(
        `Matrix ${path.split("?")[0]}: ${reply.error ?? `HTTP ${response.status}`}`,
        response.status,
      );
    return reply;
  }

  /** The bot's own user id, so its messages aren't read as input. */
  async whoami(): Promise<string> {
    this.userId ??= (await this.call<{ user_id: string }>("GET", "/account/whoami")).user_id;
    return this.userId;
  }

  /**
   * One `/sync`. Without `since`, it only finds where now is: history from before the bridge ran
   * is not answered.
   */
  sync(since: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<SyncResponse> {
    const query = new URLSearchParams({ timeout: String(since === undefined ? 0 : timeoutMs) });
    if (since !== undefined) query.set("since", since);
    else query.set("filter", JSON.stringify({ room: { timeline: { limit: 0 } } }));
    return this.call(
      "GET",
      `/sync?${query}`,
      undefined,
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 30_000)]),
    );
  }

  async join(roomId: string): Promise<void> {
    await this.call("POST", `/rooms/${encodeURIComponent(roomId)}/join`, {});
  }

  async send(chatId: string, text: string): Promise<string> {
    const txn = randomBytes(12).toString("hex");
    const reply = await this.call<{ event_id: string }>(
      "PUT",
      `/rooms/${encodeURIComponent(chatId)}/send/m.room.message/${txn}`,
      { msgtype: "m.text", body: text },
    );
    return reply.event_id;
  }

  /** What the bridge reads from a sync: text messages from others, in order. */
  async inbound(sync: SyncResponse): Promise<Inbound[]> {
    const me = await this.whoami();
    const found: Inbound[] = [];
    for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
      const count = room.summary?.["m.joined_member_count"];
      if (count !== undefined) this.members.set(roomId, count);
      for (const event of room.timeline?.events ?? []) {
        if (event.type !== "m.room.message" || event.sender === me) continue;
        if (event.content?.msgtype !== "m.text" || typeof event.content.body !== "string") continue;
        found.push({
          type: "message",
          chat: { id: roomId, private: (await this.memberCount(roomId)) <= 2 },
          sender: { id: event.sender, name: localpart(event.sender) },
          text: event.content.body,
          id: event.event_id,
        });
      }
    }
    return found;
  }

  private async memberCount(roomId: string): Promise<number> {
    const known = this.members.get(roomId);
    if (known !== undefined) return known;
    const { joined } = await this.call<{ joined: Record<string, unknown> }>(
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/joined_members`,
    );
    const count = Object.keys(joined).length;
    this.members.set(roomId, count);
    return count;
  }
}

function localpart(userId: string): string {
  return /^@([^:]+):/.exec(userId)?.[1] ?? userId;
}
