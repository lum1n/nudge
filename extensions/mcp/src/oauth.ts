import type { AuthProvider } from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthProvider,
  type McpOAuthState,
  type McpOAuthStateStore,
} from "@earendil-works/pi-mcp/oauth";
import type { SecretStore } from "@nudge/core";

/** A sign-in started on a room's panel, waiting for the authorization server to send them back. */
type Pending = {
  readonly roomId: string;
  readonly serverId: string;
  readonly serverUrl: string;
  readonly redirectUrl: string;
  readonly until: number;
};

/** What is kept for one server: pi-mcp's state, and the redirect its client was registered for. */
type Stored = McpOAuthState & { redirectUrl?: string };

/** How long someone has to finish signing in at the authorization server. */
const SIGN_IN_MS = 15 * 60_000;

/** Where a room server's OAuth state is kept in the extension's secrets, scoped by room. */
export const oauthSecret = (serverId: string) => `${serverId}/oauth`;

/**
 * OAuth sign-ins for the remote MCP servers rooms add: tokens and client registrations in the
 * extension's secrets, per room and server, never seen by the model. The authorization server
 * sends people back to the extension's `/oauth/callback` route on the address their app reaches
 * the server by.
 */
export class OAuthLogins {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly secrets: SecretStore,
    /** The assistant's name in URLs. */
    private readonly assistant: string,
    private readonly now: () => number,
  ) {}

  /** The redirect URI for a client that reaches the server at `base`. */
  redirectUrl(base: string): string {
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      throw new Error(`"${base}" is not an address`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("The server's address must be http or https");
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}/v1/a/${encodeURIComponent(this.assistant)}/ext/mcp/oauth/callback`;
  }

  signedIn(roomId: string, serverId: string): boolean {
    return this.load(roomId, serverId)?.tokens !== undefined;
  }

  /** Bearer tokens for calls, refreshed when they run out; undefined until someone signed in. */
  authProvider(roomId: string, serverId: string, serverUrl: string): AuthProvider | undefined {
    const stored = this.load(roomId, serverId);
    if (stored?.tokens === undefined || stored.redirectUrl === undefined) return undefined;
    // A refresh that fails needs a new sign-in, which only the panel starts.
    return adaptOAuthProvider(
      this.provider(roomId, serverId, serverUrl, stored.redirectUrl, () => {}),
    );
  }

  /**
   * Starts signing in to a server: the address to open in a browser, or "signedIn" when the
   * tokens kept still work. `base` is the address the person's app reaches this server by.
   */
  async start(
    roomId: string,
    serverId: string,
    serverUrl: string,
    base: string,
  ): Promise<{ url: string } | "signedIn"> {
    const redirectUrl = this.redirectUrl(base);
    const stored = this.load(roomId, serverId);
    const fresh: Stored = { ...stored, serverUrl: String(new URL(serverUrl)), redirectUrl };
    delete fresh.oauthState;
    delete fresh.codeVerifier;
    // A client registered for another redirect can't be sent back here; register again.
    if (stored?.redirectUrl !== redirectUrl) delete fresh.clientInformation;
    this.save(roomId, serverId, fresh);
    let opened: URL | undefined;
    const provider = this.provider(roomId, serverId, serverUrl, redirectUrl, (url) => {
      opened = url;
    });
    const result = await authorizeMcp(provider, { serverUrl, skipRefresh: true });
    if (result === "AUTHORIZED") return "signedIn";
    const state = opened?.searchParams.get("state");
    if (opened === undefined || !state) throw new Error("The server didn't say where to sign in");
    this.prune();
    this.pending.set(state, {
      roomId,
      serverId,
      serverUrl,
      redirectUrl,
      until: this.now() + SIGN_IN_MS,
    });
    return { url: String(opened) };
  }

  /**
   * Finishes a sign-in from the callback's query, and says for which room and server. Throws,
   * saying why, for an unknown or expired one or a refusal.
   */
  async finish(query: URLSearchParams): Promise<{ roomId: string; serverId: string }> {
    const state = query.get("state") ?? "";
    const pending = this.pending.get(state);
    if (pending === undefined || pending.until < this.now())
      throw new Error("This sign-in is unknown or has expired; start it again from the MCP panel.");
    this.pending.delete(state);
    const refused = query.get("error");
    if (refused !== null)
      throw new Error(`The sign-in was refused: ${query.get("error_description") ?? refused}`);
    const code = query.get("code");
    if (code === null) throw new Error("The sign-in came back without a code");
    const iss = query.get("iss");
    const provider = this.provider(
      pending.roomId,
      pending.serverId,
      pending.serverUrl,
      pending.redirectUrl,
      () => {},
    );
    const result = await authorizeMcp(provider, {
      serverUrl: pending.serverUrl,
      authorizationCode: code,
      ...(iss === null ? {} : { iss }),
    });
    if (result !== "AUTHORIZED") throw new Error("The server didn't accept the sign-in");
    return { roomId: pending.roomId, serverId: pending.serverId };
  }

  signOut(roomId: string, serverId: string): void {
    this.secrets.delete(roomId, oauthSecret(serverId));
    for (const [state, pending] of this.pending)
      if (pending.roomId === roomId && pending.serverId === serverId) this.pending.delete(state);
  }

  private provider(
    roomId: string,
    serverId: string,
    serverUrl: string,
    redirectUrl: string,
    onRedirect: (url: URL) => void,
  ): McpOAuthProvider {
    const store: McpOAuthStateStore = {
      load: () => this.load(roomId, serverId),
      // pi-mcp's state, keeping the redirect its client was registered for.
      save: (state) =>
        this.save(roomId, serverId, {
          ...state,
          redirectUrl: this.load(roomId, serverId)?.redirectUrl ?? redirectUrl,
        }),
    };
    return new McpOAuthProvider({
      serverUrl,
      redirectUrl,
      clientMetadata: { client_name: "Nudge" },
      store,
      onRedirect,
    });
  }

  private load(roomId: string, serverId: string): Stored | undefined {
    const value = this.secrets.get(roomId, oauthSecret(serverId));
    return value === undefined ? undefined : (JSON.parse(value) as Stored);
  }

  private save(roomId: string, serverId: string, state: Stored): void {
    this.secrets.set(roomId, oauthSecret(serverId), JSON.stringify(state));
  }

  private prune(): void {
    const now = this.now();
    for (const [state, pending] of this.pending)
      if (pending.until < now) this.pending.delete(state);
  }
}
