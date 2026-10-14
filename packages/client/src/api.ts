import type {
  Approval,
  AssistantsResponse,
  ClientInfo,
  CreateRoomRequest,
  ErrorResponse,
  Fact,
  MeResponse,
  MessageRequest,
  MessageResponse,
  PairingCodeResponse,
  PairResponse,
  Player,
  PlayerResponse,
  ProtectResponse,
  Room,
  RoomExtension,
  RoomExtensionsResponse,
  TimelineResponse,
  TokenInfo,
  TokensResponse,
} from "@nudge/protocol";

/**
 * Where a client keeps its token: in memory, `localStorage`, a keychain. `Api.pair` stores the
 * token it gets, and every request reads it again, so a token set elsewhere is picked up.
 */
export type TokenStore = {
  get(): string | undefined;
  set(token: string | undefined): void;
};

/** A token kept in memory only. */
export function memoryTokens(token?: string): TokenStore {
  return {
    get: () => token,
    set: (next) => {
      token = next;
    },
  };
}

/** A non-2xx answer: 400 bad body, 401 no or unknown token, 403 not an admin, 404, 409. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiOptions = {
  /** The server's address, such as `https://nudge.example`; `""` for the page's own origin. */
  readonly server: string;
  readonly assistant: string;
  readonly tokens: TokenStore;
  readonly fetch?: typeof fetch;
};

/** The assistants `server` hosts; needs no token. */
export async function listAssistants(
  server: string,
  fetcher: typeof fetch = fetch,
): Promise<AssistantsResponse> {
  return read(await fetcher(`${trim(server)}/v1/a`));
}

/** Protocol v1's HTTP commands for one assistant, signed in with the token in `tokens`. */
export class Api {
  readonly base: string;
  private readonly tokens: TokenStore;
  private readonly fetcher: typeof fetch;

  constructor(options: ApiOptions) {
    this.base = `${trim(options.server)}/v1/a/${encodeURIComponent(options.assistant)}`;
    this.tokens = options.tokens;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Trades a pairing code for a token, and stores it. */
  async pair(code: string, client: ClientInfo): Promise<PairResponse> {
    const paired = await this.request<PairResponse>("POST", "/pair", { code, client });
    this.tokens.set(paired.token);
    return paired;
  }

  me(): Promise<MeResponse> {
    return this.request("GET", "/me");
  }

  createRoom(body: CreateRoomRequest): Promise<Room> {
    return this.request("POST", "/rooms", body);
  }

  /** The caller's personal room, made on first use. */
  personalRoom(): Promise<Room> {
    return this.request("POST", "/rooms/personal");
  }

  /** Posts a message. Sending the same `requestId` again is answered with the same submission. */
  send(room: string, body: MessageRequest): Promise<MessageResponse> {
    return this.request("POST", `${roomPath(room)}/messages`, body);
  }

  /** Stops the answer in progress, and drops the room's queued messages. */
  abort(room: string): Promise<void> {
    return this.request("POST", `${roomPath(room)}/abort`);
  }

  /** Items older than the room view's, or than `before` from an earlier page; oldest first. */
  timeline(
    room: string,
    page: { before?: string; limit?: number } = {},
  ): Promise<TimelineResponse> {
    const query = new URLSearchParams();
    if (page.before !== undefined) query.set("before", page.before);
    if (page.limit !== undefined) query.set("limit", String(page.limit));
    const search = query.size === 0 ? "" : `?${query.toString()}`;
    return this.request("GET", `${roomPath(room)}/timeline${search}`);
  }

  remember(room: string, text: string): Promise<Fact> {
    return this.request("POST", `${roomPath(room)}/memory`, { text });
  }

  forget(room: string, fact: string): Promise<void> {
    return this.request("DELETE", `${roomPath(room)}/memory/${encodeURIComponent(fact)}`);
  }

  decide(room: string, approval: string, approve: boolean): Promise<Approval> {
    return this.request("POST", `${roomPath(room)}/approvals/${encodeURIComponent(approval)}`, {
      approve,
    });
  }

  async roomExtensions(room: string): Promise<RoomExtension[]> {
    return (await this.request<RoomExtensionsResponse>("GET", `${roomPath(room)}/extensions`))
      .extensions;
  }

  /** Turns an extension on or off in the room; `null` goes back to the default for its kind. */
  setRoomExtension(
    room: string,
    extension: string,
    enabled: boolean | null,
  ): Promise<RoomExtension> {
    return this.request("PUT", `${roomPath(room)}/extensions/${encodeURIComponent(extension)}`, {
      enabled,
    });
  }

  cancelNudge(nudge: string): Promise<void> {
    return this.request("DELETE", `/nudges/${encodeURIComponent(nudge)}`);
  }

  /** A placeholder that stands for `value` in what the model sees. */
  async protect(value: string, kind?: string): Promise<string> {
    const body = kind === undefined ? { value } : { value, kind };
    return (await this.request<ProtectResponse>("POST", "/protect", body)).placeholder;
  }

  // Admin routes, for players with the admin flag.

  async createPlayer(displayName: string): Promise<Player> {
    return (await this.request<PlayerResponse>("POST", "/admin/players", { displayName })).player;
  }

  pairingCode(playerId: string): Promise<PairingCodeResponse> {
    return this.request("POST", "/admin/pairing-codes", { playerId });
  }

  async listTokens(playerId?: string): Promise<TokenInfo[]> {
    const query = playerId === undefined ? "" : `?player=${encodeURIComponent(playerId)}`;
    return (await this.request<TokensResponse>("GET", `/admin/tokens${query}`)).tokens;
  }

  /** Revokes a client's token; its sockets close with 4401. */
  revoke(clientId: string): Promise<void> {
    return this.request("DELETE", `/admin/tokens/${encodeURIComponent(clientId)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const token = this.tokens.get();
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    return read(
      await this.fetcher(`${this.base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
}

async function read<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ErrorResponse | undefined;
    throw new ApiError(response.status, body?.error ?? response.statusText);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

function roomPath(room: string): string {
  return `/rooms/${encodeURIComponent(room)}`;
}

function trim(server: string): string {
  return server.replace(/\/+$/, "");
}
