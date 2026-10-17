import type {
  ClientInfo,
  CreateAssistantRequest,
  CreateAssistantResponse,
  DeleteAssistantResponse,
  ProviderKey,
  ProviderKeysResponse,
  RecoveryKitResponse,
  ServerAssistant,
  ServerAssistantsResponse,
  ServerInfoResponse,
  ServerOwner,
  ServerOwnersResponse,
  ServerSessionResponse,
  SetProviderKeyRequest,
  SetupInfoResponse,
  SetupRequest,
  SetupResponse,
  UpdateAssistantRequest,
} from "@nudge/protocol";
import { read, type TokenStore, trim } from "./api.ts";

/**
 * Setup mode (ADR 11): whether `server` waits to be set up, and what it offers. Needs no token;
 * the one-time code it printed goes with every other step.
 */
export async function setupInfo(
  server: string,
  fetcher: typeof fetch = fetch,
): Promise<SetupInfoResponse> {
  return read(await fetcher(`${trim(server)}/v1/setup`));
}

/** Whether `code` is the setup code; a wrong one is a 401, and counts against a few tries. */
export async function checkSetupCode(
  server: string,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await read(await fetcher(`${trim(server)}/v1/setup/code`, post({ code })));
}

/** Tries a provider's key with one tiny request; a 400 has the provider's answer. */
export async function checkSetupKey(
  server: string,
  body: { code: string; provider: string; key: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await read(await fetcher(`${trim(server)}/v1/setup/key`, post(body)));
}

/** Sets the server up; the answer has the player's token and the owner's server token. */
export async function setUp(
  server: string,
  body: SetupRequest,
  fetcher: typeof fetch = fetch,
): Promise<SetupResponse> {
  return read(await fetcher(`${trim(server)}/v1/setup`, post(body)));
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export type ServerApiOptions = {
  /** The server's address, such as `https://nudge.example`; `""` for the page's own origin. */
  readonly server: string;
  /** Holds the owner's server token (`nudge_server_…`), not a player's. */
  readonly tokens: TokenStore;
  readonly fetch?: typeof fetch;
};

/**
 * The server's own API (ADR 11), for its owners: its assistants, the model keys set on it and who
 * owns it. Signed in with a server token, which an owner gets from `signIn` with the token of
 * their player on one of the server's assistants.
 */
export class ServerApi {
  readonly base: string;
  private readonly tokens: TokenStore;
  private readonly fetcher: typeof fetch;

  constructor(options: ServerApiOptions) {
    this.base = `${trim(options.server)}/v1/server`;
    this.tokens = options.tokens;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Trades the player token of an owner, on `assistant`, for a server token, and stores it. */
  async signIn(
    assistant: string,
    playerToken: string,
    client: ClientInfo,
  ): Promise<ServerSessionResponse> {
    const session = await this.request<ServerSessionResponse>(
      "POST",
      "/session",
      { assistant, client },
      playerToken,
    );
    this.tokens.set(session.token);
    return session;
  }

  /** Revokes this client's server token, and forgets it. */
  async signOut(): Promise<void> {
    await this.request("DELETE", "/session");
    this.tokens.set(undefined);
  }

  info(): Promise<ServerInfoResponse> {
    return this.request("GET", "");
  }

  async assistants(): Promise<ServerAssistant[]> {
    return (await this.request<ServerAssistantsResponse>("GET", "/assistants")).assistants;
  }

  /** With `firstPlayer`, it is that person's home, and the answer has their pairing code. */
  createAssistant(body: CreateAssistantRequest): Promise<CreateAssistantResponse> {
    return this.request("POST", "/assistants", body);
  }

  /** `null` puts a setting back to its default. The assistant reopens with it. */
  updateAssistant(name: string, change: UpdateAssistantRequest): Promise<ServerAssistant> {
    return this.request("PATCH", `/assistants/${encodeURIComponent(name)}`, change);
  }

  /** Deletes it for good, after a backup the server keeps for a while; returns its name. */
  async deleteAssistant(name: string): Promise<string> {
    return (
      await this.request<DeleteAssistantResponse>(
        "DELETE",
        `/assistants/${encodeURIComponent(name)}`,
      )
    ).backup;
  }

  /** Where each provider's key comes from, for every assistant or for `assistant`. */
  async keys(assistant?: string): Promise<ProviderKey[]> {
    const query = assistant === undefined ? "" : `?assistant=${encodeURIComponent(assistant)}`;
    return (await this.request<ProviderKeysResponse>("GET", `/keys${query}`)).keys;
  }

  /** Keeps a provider's key on the server once it answered a tiny request (unless `test: false`). */
  setKey(provider: string, body: SetProviderKeyRequest): Promise<ProviderKey> {
    return this.request("PUT", `/keys/${encodeURIComponent(provider)}`, body);
  }

  deleteKey(provider: string, assistant?: string): Promise<void> {
    const query = assistant === undefined ? "" : `?assistant=${encodeURIComponent(assistant)}`;
    return this.request("DELETE", `/keys/${encodeURIComponent(provider)}${query}`);
  }

  /** The backup key, sealed with `passphrase`, as a file to keep away from the server. */
  recoveryKit(passphrase: string): Promise<RecoveryKitResponse> {
    return this.request("POST", "/recovery-kit", { passphrase });
  }

  async owners(): Promise<ServerOwner[]> {
    return (await this.request<ServerOwnersResponse>("GET", "/owners")).owners;
  }

  /** Makes a player of one of the server's assistants an owner too. */
  addOwner(assistant: string, playerId: string): Promise<ServerOwner> {
    return this.request("POST", "/owners", { assistant, playerId });
  }

  /** Refused (409) for the last owner. */
  removeOwner(id: string): Promise<void> {
    return this.request("DELETE", `/owners/${encodeURIComponent(id)}`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    token = this.tokens.get(),
  ): Promise<T> {
    const headers: Record<string, string> = {};
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
