import type {
  Approval,
  AssertResponse,
  AssistantsResponse,
  CarryMemoryRequest,
  ClientInfo,
  CreateRoomRequest,
  ErrorResponse,
  ExtensionSetup,
  ExtensionSetupsResponse,
  Fact,
  Invite,
  InviteResponse,
  InvitesResponse,
  Membership,
  MembershipsResponse,
  MeResponse,
  MessageRequest,
  MessageResponse,
  ModelViewResponse,
  PairingCodeResponse,
  PairResponse,
  PlaceRequest,
  Player,
  PlayerMemoryResponse,
  PlayerResponse,
  PrivateValue,
  PrivateValuesResponse,
  PlayerSettingsResponse,
  PlayerSettingsSchema,
  Profile,
  ProtectResponse,
  PushKeyResponse,
  PushSubscribeRequest,
  RenameRoomRequest,
  Room,
  RoomExtension,
  RoomExtensionsResponse,
  RoomsResponse,
  SaveExtensionSetupsRequest,
  Sealed,
  TimelineResponse,
  TokenInfo,
  TokensResponse,
  UpdateProfileRequest,
  UsageResponse,
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

  /** Revokes this client's own token, and forgets it. */
  async signOut(): Promise<void> {
    await this.request("DELETE", "/me/token");
    this.tokens.set(undefined);
  }

  createRoom(body: CreateRoomRequest): Promise<Room> {
    return this.request("POST", "/rooms", body);
  }

  /** Gives the room a new name; its id stays. */
  renameRoom(room: string, name: string): Promise<Room> {
    return this.request("PATCH", roomPath(room), { name } satisfies RenameRoomRequest);
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

  /** The caller's own memory, and whether they share it with all their rooms. */
  myMemory(): Promise<PlayerMemoryResponse> {
    return this.request("GET", "/me/memory");
  }

  rememberForMe(text: string): Promise<Fact> {
    return this.request("POST", "/me/memory", { text });
  }

  forgetForMe(fact: string): Promise<void> {
    return this.request("DELETE", `/me/memory/${encodeURIComponent(fact)}`);
  }

  /** With `shared`, everyone in the caller's rooms, and the model there, sees their own facts. */
  shareMyMemory(shared: boolean): Promise<PlayerMemoryResponse> {
    return this.request("PUT", "/me/memory/sharing", { shared });
  }

  /** The caller's profile: name, avatar, time zone, language and preferences. */
  profile(): Promise<Profile> {
    return this.request("GET", "/me/profile");
  }

  /** Changes the fields given; `null` clears one. */
  updateProfile(update: UpdateProfileRequest): Promise<Profile> {
    return this.request("PATCH", "/me/profile", update);
  }

  /** The installed extensions that take settings from each player, with their schemas. */
  async playerSettings(): Promise<PlayerSettingsSchema[]> {
    return (await this.request<PlayerSettingsResponse>("GET", "/me/profile/extensions")).extensions;
  }

  /** What the model sees of the room: its next request's messages, personal values as placeholders. */
  async modelView(room: string): Promise<ModelViewResponse["messages"]> {
    return (await this.request<ModelViewResponse>("GET", `${roomPath(room)}/model-view`)).messages;
  }

  /** This month's model spend: the assistant's and the caller's, and every month's for admins. */
  usage(): Promise<UsageResponse> {
    return this.request("GET", "/usage");
  }

  /** The server's VAPID public key; a 404 when the server sends no pushes. */
  async pushKey(): Promise<string> {
    return (await this.request<PushKeyResponse>("GET", "/ext/push/web")).publicKey;
  }

  /** Has the server push answers, approvals and nudges in the caller's rooms to this browser. */
  subscribePush(subscription: PushSubscribeRequest): Promise<void> {
    return this.request("POST", "/ext/push/web", subscription);
  }

  unsubscribePush(endpoint: string): Promise<void> {
    return this.request("DELETE", `/ext/push/web?endpoint=${encodeURIComponent(endpoint)}`);
  }

  // Roaming, through the extension `federation`: 404 on an assistant without it. To join another
  // assistant, ask the home for an assertion with `vouchFor`, then pass it to `join` on an `Api` of
  // the assistant joined.

  /** Has the caller's home vouch for them to `place`, encrypted so only that assistant reads it. */
  async vouchFor(place: PlaceRequest): Promise<Sealed> {
    return (await this.request<AssertResponse>("POST", "/ext/federation/assert", place)).assertion;
  }

  /** Joins this assistant with an assertion from the caller's home, and stores the token. */
  async join(assertion: Sealed): Promise<PairResponse> {
    const joined = await this.request<PairResponse>("POST", "/ext/federation/join", { assertion });
    this.tokens.set(joined.token);
    return joined;
  }

  /** The assistants the caller joined from here, their home. */
  async memberships(): Promise<Membership[]> {
    return (await this.request<MembershipsResponse>("GET", "/ext/federation/memberships"))
      .memberships;
  }

  /** Starts or stops carrying the caller's own memory to an assistant they joined. */
  carryMemory(place: PlaceRequest, carry: boolean): Promise<Membership> {
    return this.request("PUT", "/ext/federation/memberships/memory", {
      ...place,
      carry,
    } satisfies CarryMemoryRequest);
  }

  /** Stops sending the caller's profile and memory to an assistant they joined. */
  leave(place: PlaceRequest): Promise<void> {
    const query = new URLSearchParams({ server: place.server, assistant: place.assistant });
    return this.request("DELETE", `/ext/federation/memberships?${query}`);
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

  /**
   * A placeholder that stands for `value` in what the model sees. `private` also hides it from
   * everyone else, wherever it shows.
   */
  async protect(
    value: string,
    options: { readonly kind?: string; readonly private?: boolean } = {},
  ): Promise<string> {
    const body = {
      value,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.private === true ? { private: true } : {}),
    };
    return (await this.request<ProtectResponse>("POST", "/protect", body)).placeholder;
  }

  /** The values only this player sees. */
  async privateValues(): Promise<PrivateValue[]> {
    return (await this.request<PrivateValuesResponse>("GET", "/me/private")).values;
  }

  /** Drops a value for good: from now on everyone, the model included, sees only `placeholder`. */
  forgetValue(placeholder: string): Promise<void> {
    return this.request("DELETE", `/vault/${encodeURIComponent(placeholder)}`);
  }

  // Admin routes, for players with the admin flag.

  async createPlayer(displayName: string): Promise<Player> {
    return (await this.request<PlayerResponse>("POST", "/admin/players", { displayName })).player;
  }

  pairingCode(playerId: string): Promise<PairingCodeResponse> {
    return this.request("POST", "/admin/pairing-codes", { playerId });
  }

  /** Every room of the assistant, not only the caller's. */
  async allRooms(): Promise<Room[]> {
    return (await this.request<RoomsResponse>("GET", "/admin/rooms")).rooms;
  }

  async listTokens(playerId?: string): Promise<TokenInfo[]> {
    const query = playerId === undefined ? "" : `?player=${encodeURIComponent(playerId)}`;
    return (await this.request<TokensResponse>("GET", `/admin/tokens${query}`)).tokens;
  }

  /** Revokes a client's token; its sockets close with 4401. */
  revoke(clientId: string): Promise<void> {
    return this.request("DELETE", `/admin/tokens/${encodeURIComponent(clientId)}`);
  }

  /** Lets the person at `address` (`name@server/assistant`) join, for a week. */
  invite(address: string): Promise<InviteResponse> {
    return this.request("POST", "/ext/federation/invites", { address });
  }

  async invites(): Promise<Invite[]> {
    return (await this.request<InvitesResponse>("GET", "/ext/federation/invites")).invites;
  }

  cancelInvite(id: string): Promise<void> {
    return this.request("DELETE", `/ext/federation/invites/${encodeURIComponent(id)}`);
  }

  /** The assistant's extensions and the ones it could add, with their settings and schemas. */
  async extensionSetups(): Promise<ExtensionSetup[]> {
    return (await this.request<ExtensionSetupsResponse>("GET", "/admin/extensions")).extensions;
  }

  /** Installs `extensions`, in order, in place of the assistant's, and keeps them in its config. */
  async saveExtensionSetups(
    extensions: SaveExtensionSetupsRequest["extensions"],
  ): Promise<ExtensionSetup[]> {
    return (await this.request<ExtensionSetupsResponse>("PUT", "/admin/extensions", { extensions }))
      .extensions;
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
