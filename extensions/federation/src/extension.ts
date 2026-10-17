import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  addressOf,
  defineNudgeExtension,
  type ExtensionHost,
  type ExtensionRoute,
  InvalidProfile,
  type Nudge,
  parseAddress,
  type PlayerHome,
  type Profile,
  ProfileDoc,
  sameHome,
  Type,
} from "@nudge/core";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { newKey, peek, publicKeyOf, seal, type Signed, unseal } from "./signing.ts";
import {
  emptyState,
  FederationDoc,
  type FederationState,
  type Invite,
  type Place,
  samePlace,
} from "./state.ts";

const VERSION = "0.1.0";

const Settings = Type.Object({
  server: Type.String({
    pattern: "^https?://",
    title: "Server address",
    description:
      "This server's address as other assistants reach it, such as https://nudge.example.com. Addresses of people here end in it.",
  }),
});

/** Where the signing key is kept in the extension's secrets. */
const KEY = ["assistant", "signing-key"] as const;
/** How long a join assertion works. */
const JOIN_TTL_MS = 5 * 60_000;
/** How long an invite waits for its person. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
/** How far apart two hosts' clocks may be. */
const SKEW_MS = 60_000;
/** Signed bodies carry a profile, with its avatar. */
const MAX_SIGNED_BYTES = 256 * 1024;

const SignedBody = Type.Object({ payload: Type.String(), signature: Type.String() });
const PlaceBody = Type.Object({ server: Type.String(), assistant: Type.String() });
const HomeBody = Type.Object({
  server: Type.String(),
  assistant: Type.String(),
  playerId: Type.String(),
});
const ProfileBody = Type.Object({
  displayName: Type.String({ minLength: 1 }),
  avatar: Type.Optional(Type.String()),
  timeZone: Type.Optional(Type.String()),
  language: Type.Optional(Type.String()),
  notifications: Type.Optional(
    Type.Object({
      answers: Type.Optional(Type.Boolean()),
      approvals: Type.Optional(Type.Boolean()),
    }),
  ),
  extensions: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()))),
});
/** What a home signs for one of its people to join another assistant. */
const JoinClaim = Type.Object({
  kind: Type.Literal("nudge.join"),
  home: HomeBody,
  audience: PlaceBody,
  profile: ProfileBody,
  issuedAt: Type.Number(),
  expiresAt: Type.Number(),
  nonce: Type.String({ minLength: 16 }),
});
/** What a home signs when one of its people changed their profile. */
const ProfileClaim = Type.Object({
  kind: Type.Literal("nudge.profile"),
  home: HomeBody,
  audience: PlaceBody,
  profile: ProfileBody,
  issuedAt: Type.Number(),
});
const KeyResponse = Type.Object({
  key: Type.String(),
  server: Type.String(),
  assistant: Type.String(),
});

export type FederationOptions = {
  /** How this assistant reaches others; tests pass one that never leaves the process. */
  readonly fetch?: typeof fetch;
  readonly report?: (error: unknown) => void;
};

/**
 * Roaming (ADR 10), with its HTTP client chosen; the default export uses the global `fetch`. As a
 * home, the assistant vouches for its people: it signs their joins elsewhere and sends their
 * profile to every assistant they joined. As a place to join, it takes people an admin invited by
 * address, once their home vouched for them.
 */
export function federationExtension(options: FederationOptions = {}) {
  return defineNudgeExtension({
    name: "federation",
    version: VERSION,
    description:
      "People from other assistants can join this one, and people here can join others. Their profile comes from their home.",
    settings: Settings,
    setup: (host) => {
      const federation = new Federation(
        host,
        options.fetch ?? fetch,
        options.report ?? ((error) => console.error("federation:", error)),
      );
      return { routes: federation.routes(), close: () => federation.close() };
    },
  });
}

class Federation {
  /** This assistant, as others name it. */
  private readonly self: Place;
  private readonly key: string;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  /** When the last profile was signed, so each one signed later is newer. */
  private signedAt = 0;

  constructor(
    private readonly host: ExtensionHost<Static<typeof Settings>, unknown>,
    private readonly fetch: typeof globalThis.fetch,
    private readonly report: (error: unknown) => void,
  ) {
    this.self = { server: host.settings.server.replace(/\/+$/, ""), assistant: host.name };
    let key = host.secrets.get(...KEY);
    if (key === undefined) {
      key = newKey();
      host.secrets.set(...KEY, key);
    }
    this.key = key;
    void host.whenOpen().then((nudge) => {
      if (this.closed) return;
      this.unsubscribe = nudge.changes.subscribe((change) => {
        if (change.kind === "profile")
          this.sendProfile(change.playerId, this.context()).catch(this.report);
      });
    });
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
  }

  routes(): ExtensionRoute[] {
    const routes: ExtensionRoute[] = [
      { method: "GET", path: "/key", auth: "none", handle: () => this.publicKey() },
      // As a home.
      {
        method: "POST",
        path: "/assert",
        auth: "player",
        handle: async (request, { player, context }) => {
          const audience = await read(request, PlaceBody);
          if (player!.home !== undefined)
            return problem(403, "Only people who live here can be vouched for");
          return this.assert(player!.id, normalize(audience), context);
        },
      },
      {
        method: "GET",
        path: "/memberships",
        auth: "player",
        handle: async (_request, { player, context }) => {
          const state = await this.state(context);
          return Response.json({ memberships: state.memberships[player!.id] ?? [] });
        },
      },
      {
        method: "DELETE",
        path: "/memberships",
        auth: "player",
        handle: async (request, { player, context }) => {
          const query = new URL(request.url).searchParams;
          const place = normalize({
            server: query.get("server") ?? "",
            assistant: query.get("assistant") ?? "",
          });
          const left = await this.commit(async (state) => {
            const list = state.memberships[player!.id] ?? [];
            const kept = list.filter((membership) => !samePlace(membership, place));
            state.memberships[player!.id] = kept;
            return kept.length < list.length;
          }, context);
          return left ? new Response(null, { status: 204 }) : problem(404, "No such membership");
        },
      },
      // As a place to join.
      {
        method: "POST",
        path: "/invites",
        auth: "admin",
        handle: async (request, { player, context }) => {
          const { address } = await read(request, Type.Object({ address: Type.String() }));
          return this.invite(address, player!.id, context);
        },
      },
      {
        method: "GET",
        path: "/invites",
        auth: "admin",
        handle: async (_request, { context }) => {
          const now = this.host.now();
          const invites = Object.values((await this.state(context)).invites)
            .filter((invite) => invite.expiresAt > now)
            .map(toInvite);
          return Response.json({ invites });
        },
      },
      {
        method: "DELETE",
        path: "/invites/:id",
        auth: "admin",
        handle: async (_request, { params, context }) => {
          const deleted = await this.commit((state) => {
            const found = params.id! in state.invites;
            delete state.invites[params.id!];
            return found;
          }, context);
          return deleted ? new Response(null, { status: 204 }) : problem(404, "No such invite");
        },
      },
      {
        method: "POST",
        path: "/join",
        auth: "none",
        maxBodyBytes: MAX_SIGNED_BYTES,
        handle: async (request, { context }) => {
          const { assertion } = await read(request, Type.Object({ assertion: SignedBody }));
          return this.join(assertion, context);
        },
      },
      {
        method: "POST",
        path: "/profile",
        auth: "none",
        maxBodyBytes: MAX_SIGNED_BYTES,
        handle: async (request, { context }) => {
          const { update } = await read(request, Type.Object({ update: SignedBody }));
          return this.takeProfile(update, context);
        },
      },
    ];
    return routes.map((route) => ({ ...route, handle: answerProblems(route.handle) }));
  }

  private publicKey(): Response {
    return Response.json({ key: publicKeyOf(this.key), ...this.self });
  }

  /** Signs that `playerId` lives here, for `audience` to let them join, and remembers it. */
  private async assert(playerId: string, audience: Place, context: Context): Promise<Response> {
    if (samePlace(audience, this.self)) return problem(400, "That is this assistant");
    // This server sends their profile there later; plain HTTP only between local test servers.
    if (!audience.server.startsWith("https://") && this.self.server.startsWith("https://"))
      return problem(400, "Other assistants are reached over HTTPS");
    const profile = await this.nudge().profiles.get(playerId, context);
    if (profile === undefined) return problem(404, "No such player");
    const now = this.host.now();
    const assertion = seal(this.key, {
      kind: "nudge.join",
      home: { ...this.self, playerId },
      audience,
      profile,
      issuedAt: now,
      expiresAt: now + JOIN_TTL_MS,
      nonce: randomUUID(),
    } satisfies Static<typeof JoinClaim>);
    // Kept before they join: the place answers 404 to profiles for someone who never did.
    await this.commit((state) => {
      const list = state.memberships[playerId] ?? [];
      if (!list.some((membership) => samePlace(membership, audience)))
        state.memberships[playerId] = [...list, { ...audience, since: now }];
    }, context);
    return Response.json({ assertion });
  }

  private async invite(address: string, by: string, context: Context): Promise<Response> {
    const home = parseAddress(address);
    if (home === undefined) return problem(400, `"${address}" is not an address`);
    if (samePlace(home, this.self)) return problem(400, `${address} lives here`);
    const now = this.host.now();
    const invite: Invite = {
      id: randomUUID(),
      home,
      by,
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
    };
    await this.commit((state) => {
      state.invites[invite.id] = invite;
    }, context);
    const link = new URL("nudge://join");
    link.searchParams.set("server", this.self.server);
    link.searchParams.set("assistant", this.self.assistant);
    return Response.json({ invite: toInvite(invite), link: link.toString() }, { status: 201 });
  }

  /**
   * Lets someone in whose home vouched for them, when an admin invited them or they joined before:
   * a player here with that home, and a token for it.
   */
  private async join(assertion: Signed, context: Context): Promise<Response> {
    const claim = peek(assertion);
    if (!Value.Check(JoinClaim, claim)) return problem(400, "Not a join assertion");
    if (!samePlace(claim.audience, this.self)) return problem(400, "Not for this assistant");
    const now = this.host.now();
    if (
      now < claim.issuedAt - SKEW_MS ||
      now > claim.expiresAt ||
      claim.expiresAt - claim.issuedAt > JOIN_TTL_MS
    )
      return problem(401, "The assertion has expired");
    const home = claim.home;
    const address = addressOf(home);
    const nudge = this.nudge();
    const state = await this.state(context);
    const before = await nudge.players.byHome(home, context);
    const guest = before === undefined ? undefined : state.guests[before.id];
    const invited = Object.values(state.invites).some(
      (invite) => invite.expiresAt > now && sameHome(invite.home, home),
    );
    if (guest === undefined && !invited) return problem(403, `No invite for ${address}`);
    // Only once someone here vouched for the address: the home is fetched from what it says.
    const key = guest?.key ?? (await this.homeKey(home));
    if (key === undefined) return problem(502, `Could not reach the home of ${address}`);
    const claimed = unseal(key, assertion);
    if (!Value.Check(JoinClaim, claimed)) return problem(401, "The home did not sign that");
    const fresh = await this.commit((state) => {
      for (const [nonce, expiresAt] of Object.entries(state.used))
        if (expiresAt < now) delete state.used[nonce];
      if (claimed.nonce in state.used) return false;
      state.used[claimed.nonce] = claimed.expiresAt;
      for (const invite of Object.values(state.invites))
        if (sameHome(invite.home, home)) delete state.invites[invite.id];
      return true;
    }, context);
    if (!fresh) return problem(401, "The assertion was used already");
    const joined = await nudge.players.addRoaming(home, claimed.profile.displayName, context);
    await this.commit((state) => {
      const profileAt = Math.max(state.guests[joined.player.id]?.profileAt ?? 0, claimed.issuedAt);
      state.guests[joined.player.id] = { key, profileAt };
    }, context);
    await this.applyProfile(joined.player.id, claimed.profile, context);
    return Response.json(
      {
        token: joined.token,
        clientId: joined.clientId,
        player: { id: joined.player.id, displayName: claimed.profile.displayName, address },
      },
      { status: 201 },
    );
  }

  /** A guest's profile from their home: applied when it is newer than the last one. */
  private async takeProfile(update: Signed, context: Context): Promise<Response> {
    const claim = peek(update);
    if (!Value.Check(ProfileClaim, claim)) return problem(400, "Not a profile");
    if (!samePlace(claim.audience, this.self)) return problem(400, "Not for this assistant");
    const player = await this.nudge().players.byHome(claim.home, context);
    const guest = player === undefined ? undefined : (await this.state(context)).guests[player.id];
    if (player === undefined || guest === undefined) return problem(404, "No such guest");
    const claimed = unseal(guest.key, update);
    if (!Value.Check(ProfileClaim, claimed)) return problem(401, "The home did not sign that");
    const newer = await this.commit((state) => {
      const current = state.guests[player.id];
      if (current === undefined || claimed.issuedAt <= current.profileAt) return false;
      current.profileAt = claimed.issuedAt;
      return true;
    }, context);
    if (newer) await this.applyProfile(player.id, claimed.profile, context);
    return new Response(null, { status: 204 });
  }

  /**
   * Makes a guest's profile here what their home says. Their settings for extensions are kept
   * as they are, also for extensions this assistant doesn't have.
   */
  private async applyProfile(
    playerId: string,
    profile: Static<typeof ProfileBody>,
    context: Context,
  ): Promise<void> {
    await this.nudge().profiles.update(
      playerId,
      {
        displayName: profile.displayName,
        avatar: profile.avatar ?? null,
        timeZone: profile.timeZone ?? null,
        language: profile.language ?? null,
        notifications: profile.notifications ?? null,
      },
      context,
    );
    await this.host.documents().commit(async (tx) => {
      const stored = await tx.doc(ProfileDoc, playerId, null);
      if (profile.extensions === undefined) delete stored.extensions;
      else stored.extensions = structuredClone(profile.extensions) as Profile["extensions"];
    }, context);
  }

  /** Sends a player's profile to every assistant they joined; those that don't know them are dropped. */
  private async sendProfile(playerId: string, context: Context): Promise<void> {
    const places = (await this.state(context)).memberships[playerId] ?? [];
    if (places.length === 0) return;
    const profile = await this.nudge().profiles.get(playerId, context);
    if (profile === undefined) return;
    this.signedAt = Math.max(this.host.now(), this.signedAt + 1);
    const gone: Place[] = [];
    for (const place of places) {
      const update = seal(this.key, {
        kind: "nudge.profile",
        home: { ...this.self, playerId },
        audience: { server: place.server, assistant: place.assistant },
        profile,
        issuedAt: this.signedAt,
      } satisfies Static<typeof ProfileClaim>);
      try {
        const response = await this.fetch(endpoint(place, "/profile"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ update }),
        });
        if (response.status === 404) gone.push(place);
        else if (!response.ok)
          this.report(new Error(`${place.server} answered ${response.status} to a profile`));
      } catch (error) {
        this.report(error);
      }
    }
    if (gone.length > 0)
      await this.commit((state) => {
        state.memberships[playerId] = (state.memberships[playerId] ?? []).filter(
          (membership) => !gone.some((place) => samePlace(place, membership)),
        );
      }, context);
  }

  /** The key `home` publishes, if it answers for itself. */
  private async homeKey(home: PlayerHome): Promise<string | undefined> {
    try {
      const response = await this.fetch(endpoint(home, "/key"));
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      if (!Value.Check(KeyResponse, body)) return undefined;
      return samePlace(normalize(body), home) ? body.key : undefined;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  private nudge(): Nudge {
    return this.host.assistant();
  }

  private context(): Context {
    // Pushes run on their own, after the change that started them was answered.
    return BACKGROUND_CONTEXT;
  }

  private async state(context: Context): Promise<FederationState> {
    return (await this.host.documents().snapshot(FederationDoc, context)) ?? emptyState();
  }

  private commit<T>(
    change: (state: FederationState) => T | Promise<T>,
    context: Context,
  ): Promise<T> {
    return this.host
      .documents()
      .commit(async (tx) => change(await tx.doc(FederationDoc)), context) as Promise<T>;
  }
}

/** A problem with a request, answered as `{ error }` with its status. */
class Problem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** `handle`, with a `Problem` it throws, or a profile its home got wrong, answered as one. */
function answerProblems(handle: ExtensionRoute["handle"]): ExtensionRoute["handle"] {
  return async (request, caller) => {
    try {
      return await handle(request, caller);
    } catch (error) {
      if (error instanceof Problem) return problem(error.status, error.message);
      if (error instanceof InvalidProfile) return problem(400, error.message);
      throw error;
    }
  };
}

/** The JSON body, checked against `schema`. */
async function read<S extends TSchema>(request: Request, schema: S): Promise<Static<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Problem(400, "Expected a JSON body");
  }
  if (!Value.Check(schema, body)) throw new Problem(400, "Unexpected body");
  return body;
}

function normalize(place: Place): Place {
  return { server: place.server.replace(/\/+$/, ""), assistant: place.assistant };
}

/** The URL of the federation route `path` of the assistant at `place`. */
function endpoint(place: Place, path: string): string {
  return `${place.server}/v1/a/${encodeURIComponent(place.assistant)}/ext/federation${path}`;
}

function toInvite(invite: Invite) {
  return {
    id: invite.id,
    address: addressOf(invite.home),
    by: invite.by,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  };
}
export default federationExtension();
