import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  addressOf,
  ASSERTION_TTL_MS,
  type Change,
  checkSigned,
  defineNudgeExtension,
  type ExtensionHost,
  federationEndpoint,
  fetchKeys,
  type ExtensionRoute,
  InvalidProfile,
  isWiredHost,
  MAX_FACTS,
  newKey,
  type Nudge,
  open,
  parseAddress,
  peek,
  PlayerMemoryDoc,
  type Profile,
  ProfileDoc,
  publicKeyOf,
  sameHome,
  seal,
  type Sealed,
  type Signed,
  signPayload,
  SKEW_MS,
  Type,
} from "@nudge/core";
import {
  type AssertResponse,
  CarryMemoryRequest,
  type InviteResponse,
  type InvitesResponse,
  InviteRequest,
  JoinRequest,
  type Invite as ShownInvite,
  type Membership as ShownMembership,
  type MembershipsResponse,
  type OwnedServer as ShownOwnedServer,
  type OwnedServersResponse,
  type PairResponse,
  Sealed as SealedBody,
  ServerKeyResponse,
  ServerRequest,
} from "@nudge/protocol";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  ClosedClaim,
  FactBody,
  ForgetClaim,
  JoinClaim,
  KeysBody,
  KeysClaim,
  LeaveClaim,
  MemoryClaim,
  OwnerClaim,
  PlaceBody,
  ProfileBody,
  ProfileClaim,
  RememberClaim,
} from "./messages.ts";
import {
  emptyState,
  FederationDoc,
  type FederationState,
  type Invite,
  type Keys,
  type Membership,
  type OwnedServer,
  type Place,
  samePlace,
} from "./state.ts";

const VERSION = "0.2.0";

const Settings = Type.Object({
  server: Type.String({
    pattern: "^https?://",
    title: "Server address",
    description:
      "This server's address as other assistants reach it, such as https://nudge.example.com. Addresses of people here end in it.",
  }),
});

/** Where the keys are kept in the extension's secrets. */
const SCOPE = "assistant";
/** How long an invite waits for its person. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
/** How many rotations `GET /key` shows, and how many old encryption keys still open messages. */
const MAX_ROTATIONS = 8;
/** Sealed bodies carry a profile, with its avatar, or a whole memory. */
const MAX_SEALED_BYTES = 512 * 1024;
const PLACEHOLDER = /⟦[A-Z]+\d+⟧/g;

type CarriedFact = Static<typeof FactBody>;

export type FederationOptions = {
  /** How this assistant reaches others; tests pass one that never leaves the process. */
  readonly fetch?: typeof fetch;
  readonly report?: (error: unknown) => void;
};

/**
 * Roaming (ADR 10), with its HTTP client chosen; the default export uses the global `fetch`. As a
 * home, the assistant vouches for its people: it signs their joins elsewhere, and sends their
 * profile, and their own memory where they allow it, to every assistant they joined. As a place to
 * join, it takes people an admin invited by address, once their home vouched for them. Everything
 * between assistants is signed by the sender and encrypted for the receiver.
 */
export function federationExtension(options: FederationOptions = {}) {
  return defineNudgeExtension({
    name: "federation",
    version: VERSION,
    description:
      "People from other assistants can join this one, and people here can join others. Their profile, and their own memory if they allow it, come from their home.",
    settings: Settings,
    setup: (host) => {
      const federation = new Federation(
        host,
        options.fetch ?? fetch,
        options.report ?? ((error) => console.error("federation:", error)),
      );
      return {
        routes: federation.routes(),
        close: () => federation.close(),
        retire: (context) => federation.retire(context),
      };
    },
  });
}

class Federation {
  /** This assistant, as others name it. */
  private readonly self: Place;
  private signingKey: string;
  private encryptionKey: string;
  /** Encryption keys from before the last rotations, newest first, for what is still sealed to them. */
  private previousKeys: string[];
  /** The last rotations, oldest first, as `GET /key` shows them. */
  private rotations: Signed[];
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  /** When the last message was signed, so each one signed later is newer. */
  private signedAt = 0;
  /** Work for each player, one after the other, so their messages go and apply in order. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly host: ExtensionHost<Static<typeof Settings>, unknown>,
    private readonly fetch: typeof globalThis.fetch,
    private readonly report: (error: unknown) => void,
  ) {
    this.self = { server: trimmed(host.settings.server), assistant: host.name };
    this.signingKey = this.ownKey("signing-key", "ed25519");
    this.encryptionKey = this.ownKey("encryption-key", "x25519");
    this.previousKeys = this.listed("previous-encryption-keys") as string[];
    this.rotations = this.listed("rotations") as Signed[];
    void host.whenOpen().then((nudge) => {
      if (this.closed) return;
      this.unsubscribe = nudge.changes.subscribe((change) => this.changed(change));
    });
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
  }

  private ownKey(name: string, type: "ed25519" | "x25519"): string {
    let key = this.host.secrets.get(SCOPE, name);
    if (key === undefined) {
      key = newKey(type);
      this.host.secrets.set(SCOPE, name, key);
    }
    return key;
  }

  private listed(name: string): unknown[] {
    const stored = this.host.secrets.get(SCOPE, name);
    return stored === undefined ? [] : (JSON.parse(stored) as unknown[]);
  }

  /**
   * New keys, signed for by the old signing key, so whoever pinned it follows along the next time
   * a message from here doesn't check out. What was sealed to the old encryption key still opens.
   * It doesn't help when a key leaked: whoever has it can sign for keys of their own.
   */
  private rotate(): Response {
    const signingKey = newKey("ed25519");
    const encryptionKey = newKey("x25519");
    const rotation = signPayload(this.signingKey, {
      kind: "nudge.keys",
      ...this.self,
      signingKey: publicKeyOf(signingKey),
      encryptionKey: publicKeyOf(encryptionKey),
      issuedAt: this.nextSignedAt(),
    } satisfies Static<typeof KeysClaim>);
    this.rotations = [...this.rotations, rotation].slice(-MAX_ROTATIONS);
    this.previousKeys = [this.encryptionKey, ...this.previousKeys].slice(0, MAX_ROTATIONS);
    this.signingKey = signingKey;
    this.encryptionKey = encryptionKey;
    const secrets = this.host.secrets;
    secrets.set(SCOPE, "rotations", JSON.stringify(this.rotations));
    secrets.set(SCOPE, "previous-encryption-keys", JSON.stringify(this.previousKeys));
    secrets.set(SCOPE, "signing-key", signingKey);
    secrets.set(SCOPE, "encryption-key", encryptionKey);
    return Response.json(this.publicKeys());
  }

  private publicKeys(): Static<typeof KeysBody> {
    return {
      ...this.self,
      signingKey: publicKeyOf(this.signingKey),
      encryptionKey: publicKeyOf(this.encryptionKey),
      ...(this.rotations.length === 0 ? {} : { rotations: this.rotations }),
    };
  }

  /** The signed message in `sealed`, if it was sealed to this assistant's key, or an earlier one. */
  private open(sealed: Sealed): Signed | undefined {
    for (const key of [this.encryptionKey, ...this.previousKeys]) {
      const signed = open(key, sealed);
      if (signed !== undefined) return signed;
    }
    return undefined;
  }

  private changed(change: Change): void {
    if (change.kind !== "profile" && change.kind !== "player-memory") return;
    const { playerId } = change;
    void this.enqueue(playerId, async () => {
      const context = BACKGROUND_CONTEXT;
      const player = await this.nudge().players.get(playerId, context);
      if (player === undefined) return;
      if (player.home !== undefined) {
        if (change.kind === "player-memory") await this.forwardMemory(playerId, context);
      } else if (change.kind === "profile") await this.sendProfile(playerId, context);
      else await this.sendMemory(playerId, undefined, context);
    });
  }

  private enqueue(playerId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(playerId) ?? Promise.resolve()).then(work).catch(this.report);
    this.queues.set(playerId, next);
    return next;
  }

  routes(): ExtensionRoute[] {
    const routes: ExtensionRoute[] = [
      {
        method: "GET",
        path: "/key",
        auth: "none",
        handle: () => Response.json(this.publicKeys()),
      },
      {
        method: "POST",
        path: "/keys",
        auth: "admin",
        handle: () => this.rotate(),
      },
      // As a home.
      {
        method: "POST",
        path: "/assert",
        auth: "player",
        handle: async (request, { player, context }) => {
          const audience = trimmedPlace(await read(request, PlaceBody));
          if (player!.home !== undefined)
            return problem(403, "Only people who live here can be vouched for");
          return this.assert(player!.id, audience, context);
        },
      },
      {
        method: "GET",
        path: "/memberships",
        auth: "player",
        handle: async (_request, { player, context }) => {
          const state = await this.state(context);
          return Response.json({
            address: addressOf(player!.home ?? { ...this.self, playerId: player!.id }),
            memberships: (state.memberships[player!.id] ?? []).map(shown),
          } satisfies MembershipsResponse);
        },
      },
      {
        method: "PUT",
        path: "/memberships/memory",
        auth: "player",
        handle: async (request, { player, context }) => {
          const body = await read(request, CarryMemoryRequest);
          return this.setCarry(player!.id, trimmedPlace(body), body.carry, context);
        },
      },
      {
        method: "DELETE",
        path: "/memberships",
        auth: "player",
        handle: async (request, { player, context }) => {
          const query = new URL(request.url).searchParams;
          const place = trimmedPlace({
            server: query.get("server") ?? "",
            assistant: query.get("assistant") ?? "",
          });
          const found = (await this.state(context)).memberships[player!.id]?.find((m) =>
            samePlace(m, place),
          );
          if (found === undefined) return problem(404, "No such membership");
          // After what is on its way there; dropped here even when the place can't be reached.
          await this.enqueue(player!.id, async () => {
            await this.send(found, found, {
              kind: "nudge.leave",
              home: { ...this.self, playerId: player!.id },
              audience: placeOf(found),
              issuedAt: this.nextSignedAt(),
            } satisfies Static<typeof LeaveClaim>);
            await this.dropMemberships(player!.id, [found], context);
          });
          return new Response(null, { status: 204 });
        },
      },
      // As a home: the servers its people own (ADR 11), for all their devices.
      {
        method: "GET",
        path: "/servers",
        auth: "player",
        handle: async (_request, { player, context }) => {
          if (player!.home !== undefined)
            return problem(403, "Only people who live here keep servers here");
          const servers = (await this.state(context)).servers?.[player!.id] ?? [];
          return Response.json({
            servers: servers.map(shownServer),
          } satisfies OwnedServersResponse);
        },
      },
      {
        method: "PUT",
        path: "/servers",
        auth: "player",
        handle: async (request, { player, context }) => {
          const server = trimmed((await read(request, ServerRequest)).server);
          if (player!.home !== undefined)
            return problem(403, "Only people who live here keep servers here");
          const servers = await this.commit((state) => {
            const all = (state.servers ??= {});
            const list = (all[player!.id] ?? []).filter((owned) => owned.server !== server);
            const known = all[player!.id]?.find((owned) => owned.server === server);
            all[player!.id] = [...list, { server, since: known?.since ?? this.host.now() }].sort(
              (a, b) => a.server.localeCompare(b.server),
            );
            return all[player!.id]!.map(shownServer);
          }, context);
          return Response.json({ servers } satisfies OwnedServersResponse);
        },
      },
      {
        method: "DELETE",
        path: "/servers",
        auth: "player",
        handle: async (request, { player, context }) => {
          const server = trimmed(new URL(request.url).searchParams.get("server") ?? "");
          if (player!.home !== undefined)
            return problem(403, "Only people who live here keep servers here");
          const removed = await this.commit((state) => {
            const list = state.servers?.[player!.id];
            if (list === undefined || !list.some((owned) => owned.server === server)) return false;
            state.servers![player!.id] = list.filter((owned) => owned.server !== server);
            return true;
          }, context);
          return removed ? new Response(null, { status: 204 }) : problem(404, "No such server");
        },
      },
      {
        method: "POST",
        path: "/owner-assertion",
        auth: "player",
        handle: async (request, { player }) => {
          const server = trimmed((await read(request, ServerRequest)).server);
          if (player!.home !== undefined)
            return problem(403, "Only people who live here can be vouched for");
          return this.assertOwner(player!.id, server);
        },
      },
      // As a place to join.
      {
        method: "POST",
        path: "/invites",
        auth: "admin",
        handle: async (request, { player, context }) => {
          const { address } = await read(request, InviteRequest);
          // Without a player, the server's owner is making the assistant for that person.
          return this.invite(address, player?.id ?? "server", context);
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
          return Response.json({ invites } satisfies InvitesResponse);
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
        maxBodyBytes: MAX_SEALED_BYTES,
        handle: async (request, { context }) => {
          const { assertion } = await read(request, JoinRequest);
          return this.join(assertion, context);
        },
      },
      // Both: what other assistants send.
      {
        method: "POST",
        path: "/inbox",
        auth: "none",
        maxBodyBytes: MAX_SEALED_BYTES,
        handle: async (request, { context }) => {
          const { message } = await read(request, Type.Object({ message: SealedBody }));
          return this.receive(message, context);
        },
      },
    ];
    return routes.map((route) => ({ ...route, handle: answerProblems(route.handle) }));
  }

  /**
   * Signs that `playerId` lives here, encrypted for `audience` so only it can read their profile,
   * and remembers the place and its keys.
   */
  private async assert(playerId: string, audience: Place, context: Context): Promise<Response> {
    if (samePlace(audience, this.self)) return problem(400, "That is this assistant");
    // This server writes to it later: over HTTPS, or Wired, which encrypts on its own. Plain
    // HTTP otherwise only between local test servers.
    if (!secureServer(audience.server) && secureServer(this.self.server))
      return problem(400, "Other assistants are reached over HTTPS");
    const profile = await this.nudge().profiles.get(playerId, context);
    if (profile === undefined) return problem(404, "No such player");
    const known = (await this.state(context)).memberships[playerId]?.find((m) =>
      samePlace(m, audience),
    );
    const keys = known ?? (await this.keysOf(audience));
    if (keys === undefined) return problem(502, `Could not reach ${audience.server}`);
    const now = this.host.now();
    const assertion = seal(this.signingKey, keys.encryptionKey, {
      kind: "nudge.join",
      home: { ...this.self, playerId },
      audience,
      profile,
      issuedAt: now,
      expiresAt: now + ASSERTION_TTL_MS,
      nonce: randomUUID(),
    } satisfies Static<typeof JoinClaim>);
    // Kept before they join: the place refuses messages for someone who never did.
    if (known === undefined)
      await this.commit((state) => {
        const list = state.memberships[playerId] ?? [];
        if (!list.some((membership) => samePlace(membership, audience)))
          state.memberships[playerId] = [
            ...list,
            {
              ...audience,
              signingKey: keys.signingKey,
              encryptionKey: keys.encryptionKey,
              since: now,
              carry: false,
              seen: {},
            },
          ];
      }, context);
    return Response.json({ assertion } satisfies AssertResponse);
  }

  /**
   * Signs that `playerId` lives here, for a server they own to give them a server token (ADR 11):
   * sealed for that server's own keys, so no assistant there is needed. Nothing is kept: the
   * server checks that they are an owner.
   */
  private async assertOwner(playerId: string, server: string): Promise<Response> {
    if (!secureServer(server) && secureServer(this.self.server))
      return problem(400, "Other servers are reached over HTTPS");
    const keys = await this.serverKeys(server);
    if (keys === undefined) return problem(502, `Could not reach ${server}`);
    const now = this.host.now();
    const assertion = seal(this.signingKey, keys.encryptionKey, {
      kind: "nudge.owner",
      home: { ...this.self, playerId },
      audience: { server, key: keys.signingKey },
      issuedAt: now,
      expiresAt: now + ASSERTION_TTL_MS,
      nonce: randomUUID(),
    } satisfies Static<typeof OwnerClaim>);
    return Response.json({ assertion } satisfies AssertResponse);
  }

  /** A server's own keys, from its `GET /v1/server/key`. */
  private async serverKeys(server: string): Promise<Keys | undefined> {
    try {
      const response = await this.fetch(`${server}/v1/server/key`);
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      return Value.Check(ServerKeyResponse, body)
        ? { signingKey: body.signingKey, encryptionKey: body.encryptionKey }
        : undefined;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  /** Starts or stops carrying a player's own memory to one place they joined. */
  private async setCarry(
    playerId: string,
    place: Place,
    carry: boolean,
    context: Context,
  ): Promise<Response> {
    const membership = await this.commit((state) => {
      const found = state.memberships[playerId]?.find((m) => samePlace(m, place));
      if (found !== undefined) found.carry = carry;
      return found === undefined ? undefined : shown(found);
    }, context);
    if (membership === undefined) return problem(404, "No such membership");
    await this.enqueue(playerId, () =>
      this.sendMemory(playerId, place, context, { stopping: !carry }),
    );
    return Response.json(membership);
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
    return Response.json(
      { invite: toInvite(invite), link: link.toString() } satisfies InviteResponse,
      { status: 201 },
    );
  }

  /**
   * Lets someone in whose home vouched for them, when an admin invited them or they joined before:
   * a player here with that home, and a token for it.
   */
  private async join(assertion: Sealed, context: Context): Promise<Response> {
    const signed = this.open(assertion);
    if (signed === undefined) return problem(400, "That was not encrypted for this assistant");
    const claim = peek(signed);
    if (!Value.Check(JoinClaim, claim)) return problem(400, "Not a join assertion");
    if (!samePlace(claim.audience, this.self)) return problem(400, "Not for this assistant");
    const now = this.host.now();
    if (
      now < claim.issuedAt - SKEW_MS ||
      now > claim.expiresAt ||
      claim.expiresAt - claim.issuedAt > ASSERTION_TTL_MS
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
    // The first player of a server set up from their home is theirs to join without an invite.
    const started = guest === undefined ? before?.startedFrom : undefined;
    if (guest === undefined && !invited && started === undefined)
      return problem(403, `No invite for ${address}`);
    // Only once someone here vouched for the address: the home is fetched from what it says.
    const pinned = guest ?? started?.keys ?? (await this.keysOf(home));
    if (pinned === undefined) return problem(502, `Could not reach the home of ${address}`);
    const checked = await this.checkFrom(home, pinned, signed, context);
    if (checked === undefined || !Value.Check(JoinClaim, checked.claim))
      return problem(401, "The home did not sign that");
    const { claim: claimed, keys } = checked;
    // Set up while this server couldn't reach the home: it must have signed what setup was sent.
    if (started?.proof !== undefined) {
      const vouched = checkSigned(keys.signingKey, started.proof);
      if (!Value.Check(OwnerClaim, vouched) || !sameHome(vouched.home, home))
        return problem(403, `This server wasn't set up from the home of ${address}`);
    }
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
    if (started?.proof !== undefined) await nudge.players.confirmHome(before!.id, keys, context);
    const applies = await this.commit((state) => {
      const current = state.guests[joined.player.id];
      if (current === undefined)
        state.guests[joined.player.id] = {
          signingKey: keys.signingKey,
          encryptionKey: keys.encryptionKey,
          // A leave from before they joined, replayed, mustn't end this stay.
          seen: { "nudge.profile": claimed.issuedAt, "nudge.leave": claimed.issuedAt },
          carry: false,
          carried: {},
          forwarded: [],
        };
      else if ((current.seen["nudge.profile"] ?? 0) < claimed.issuedAt)
        current.seen["nudge.profile"] = claimed.issuedAt;
      else return false;
      return true;
    }, context);
    if (applies) await this.applyProfile(joined.player.id, claimed.profile, context);
    return Response.json(
      {
        token: joined.token,
        clientId: joined.clientId,
        player: { id: joined.player.id, displayName: claimed.profile.displayName, address },
      } satisfies PairResponse,
      { status: 201 },
    );
  }

  /** A message from another assistant: opened, its sender checked, then applied once. */
  private async receive(message: Sealed, context: Context): Promise<Response> {
    const signed = this.open(message);
    if (signed === undefined) return problem(400, "That was not encrypted for this assistant");
    const claim = peek(signed) as { kind?: unknown } | undefined;
    switch (claim?.kind) {
      case "nudge.profile":
      case "nudge.memory":
      case "nudge.leave":
        return this.fromHome(signed, context);
      case "nudge.remember":
      case "nudge.forget":
        return this.fromPlace(signed, context);
      case "nudge.closed":
        return this.placeClosed(signed, context);
      default:
        return problem(400, "Unknown message");
    }
  }

  /** A guest's profile or own memory, or that they left, from their home. */
  private async fromHome(signed: Signed, context: Context): Promise<Response> {
    const claim = peek(signed);
    const schema = [ProfileClaim, MemoryClaim, LeaveClaim].find((schema) =>
      Value.Check(schema, claim),
    );
    if (schema === undefined || !Value.Check(schema, claim))
      return problem(400, "Malformed message");
    if (!samePlace(claim.audience, this.self)) return problem(400, "Not for this assistant");
    const player = await this.nudge().players.byHome(claim.home, context);
    const guest = player === undefined ? undefined : (await this.state(context)).guests[player.id];
    if (player === undefined || guest === undefined) return problem(404, "No such guest");
    const checked = await this.checkFrom(claim.home, guest, signed, context);
    const claimed = checked?.claim;
    if (!Value.Check(schema, claimed)) return problem(401, "The home did not sign that");
    // Not waited for: the home may be waiting for this player's queue here to answer it.
    void this.enqueue(player.id, async () => {
      const newer = await this.commit((state) => {
        const current = state.guests[player.id];
        if (current === undefined || claimed.issuedAt <= (current.seen[claimed.kind] ?? 0))
          return false;
        current.seen[claimed.kind] = claimed.issuedAt;
        return true;
      }, context);
      if (!newer) return;
      if (Value.Check(ProfileClaim, claimed))
        await this.applyProfile(player.id, claimed.profile, context);
      else if (Value.Check(MemoryClaim, claimed))
        await this.applyMemory(player.id, claimed, context);
      else await this.applyLeave(player.id, context);
    });
    return new Response(null, { status: 204 });
  }

  /**
   * A guest left from their home: their tokens here stop, which closes their sockets and ends
   * their pushes, and what came from home goes. Joining again takes a new invite. The player
   * stays, so the rooms' history still names them.
   */
  private async applyLeave(playerId: string, context: Context): Promise<void> {
    const nudge = this.nudge();
    for (const { clientId } of await nudge.players.tokens(playerId, context))
      await nudge.players.revoke(clientId, context);
    await this.host.documents().commit(async (tx) => {
      const state = await tx.doc(FederationDoc);
      const guest = state.guests[playerId];
      if (guest === undefined) return;
      const memory = await tx.doc(PlayerMemoryDoc, playerId, null);
      memory.facts = memory.facts
        .filter((fact) => !(fact.id in guest.carried))
        .map((fact) => structuredClone({ ...fact }));
      delete state.guests[playerId];
    }, context);
    await this.memoryChanged(playerId, context);
  }

  /**
   * Tells every guest's home that this assistant is being deleted, so their memberships here go
   * and their apps stop signing in. Each home is told once, all at the same time; a home that
   * can't be reached keeps the membership until the person leaves it.
   */
  async retire(context: Context): Promise<void> {
    const nudge = this.nudge();
    const { guests } = await this.state(context);
    await Promise.all(
      Object.entries(guests).map(async ([playerId, guest]) => {
        const player = await nudge.players.get(playerId, context);
        if (player?.home === undefined) return;
        const home: Place = { server: player.home.server, assistant: player.home.assistant };
        await this.send(home, guest, {
          kind: "nudge.closed",
          from: this.self,
          audience: home,
          playerId: player.home.playerId,
          issuedAt: this.nextSignedAt(),
        } satisfies Static<typeof ClosedClaim>);
      }),
    );
  }

  /** An assistant one of this home's people joined is gone: their membership there ends. */
  private async placeClosed(signed: Signed, context: Context): Promise<Response> {
    const claim = peek(signed);
    if (!Value.Check(ClosedClaim, claim)) return problem(400, "Malformed message");
    if (!samePlace(claim.audience, this.self)) return problem(400, "Not for this assistant");
    const from = trimmedPlace(claim.from);
    const membership = (await this.state(context)).memberships[claim.playerId]?.find((m) =>
      samePlace(m, from),
    );
    if (membership === undefined) return problem(404, "No such membership");
    const checked = await this.checkFrom(from, membership, signed, context);
    const claimed = checked?.claim;
    if (!Value.Check(ClosedClaim, claimed)) return problem(401, "That assistant did not sign that");
    // One signed before they joined, replayed, mustn't end a newer stay.
    if (claimed.issuedAt <= membership.since) return problem(409, "That is older than the stay");
    // Not waited for, as the other messages: the place may be waiting for this player's queue.
    void this.enqueue(claimed.playerId, () =>
      this.dropMemberships(claimed.playerId, [from], context),
    );
    return new Response(null, { status: 204 });
  }

  /** A fact one of this home's people remembered or forgot elsewhere, for their own memory. */
  private async fromPlace(signed: Signed, context: Context): Promise<Response> {
    const claim = peek(signed);
    const schema = Value.Check(RememberClaim, claim) ? RememberClaim : ForgetClaim;
    if (!Value.Check(schema, claim)) return problem(400, "Malformed message");
    if (!samePlace(claim.audience, this.self)) return problem(400, "Not for this assistant");
    const from = trimmedPlace(claim.from);
    const membership = (await this.state(context)).memberships[claim.playerId]?.find((m) =>
      samePlace(m, from),
    );
    if (membership === undefined) return problem(404, "No such membership");
    const checked = await this.checkFrom(from, membership, signed, context);
    const claimed = checked?.claim;
    if (!Value.Check(schema, claimed)) return problem(401, "That assistant did not sign that");
    // Only with their consent: memory goes both ways or not at all.
    if (!membership.carry) return problem(403, "Their memory isn't carried there");
    const { playerId } = claimed;
    // In the player's queue, so the memory their change sends knows where the fact came from.
    // Not waited for: that place may be waiting for this player's queue here to answer it.
    void this.enqueue(playerId, async () => {
      const newer = await this.commit((state) => {
        const current = state.memberships[playerId]?.find((m) => samePlace(m, from));
        if (current === undefined || claimed.issuedAt <= (current.seen[claimed.kind] ?? 0))
          return false;
        current.seen[claimed.kind] = claimed.issuedAt;
        return true;
      }, context);
      if (!newer) return;
      if (Value.Check(RememberClaim, claimed)) await this.rememberFrom(from, claimed, context);
      else await this.nudge().memory.forgetFor(playerId, claimed.factId, context);
    });
    return new Response(null, { status: 204 });
  }

  /**
   * Remembers a fact one of this home's people remembered at `from`, and that it came from there.
   * Once only: a remember sent again, after its answer got lost, finds it there already.
   */
  private async rememberFrom(
    from: Place,
    claim: Static<typeof RememberClaim>,
    context: Context,
  ): Promise<void> {
    const membership = (await this.state(context)).memberships[claim.playerId]?.find((m) =>
      samePlace(m, from),
    );
    if (Object.values(membership?.origins ?? {}).includes(claim.factId)) return;
    const nudge = this.nudge();
    const player = await nudge.players.get(claim.playerId, context);
    const text = await this.protectFact(claim.fact);
    if (player === undefined || text === undefined) return;
    const fact = await nudge.memory.rememberFor(claim.playerId, text, context, {
      playerId: player.id,
      displayName: player.displayName,
    });
    await this.commit((state) => {
      const current = state.memberships[claim.playerId]?.find((m) => samePlace(m, from));
      if (current !== undefined) current.origins = { ...current.origins, [fact.id]: claim.factId };
    }, context);
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

  /**
   * Makes a guest's own memory here what their home carries: its facts, their values protected
   * here, then what they remembered here that hasn't come back yet. A fact that went home comes
   * back naming its id here as `origin`, and takes its place. When the home stops carrying, the
   * facts that came from it go.
   */
  private async applyMemory(
    playerId: string,
    claim: Static<typeof MemoryClaim>,
    context: Context,
  ): Promise<void> {
    const incoming: { id: string; text: string; createdAt: number; origin?: string }[] = [];
    if (claim.carry)
      for (const fact of claim.facts.slice(0, MAX_FACTS)) {
        const text = await this.protectFact(fact);
        if (text !== undefined)
          incoming.push({ id: fact.id, text, createdAt: fact.createdAt, origin: fact.origin });
      }
    await this.host.documents().commit(async (tx) => {
      const memory = await tx.doc(PlayerMemoryDoc, playerId, null);
      const guest = (await tx.doc(FederationDoc)).guests[playerId];
      if (guest === undefined) return;
      const localOf = new Map(Object.entries(guest.carried).map(([local, home]) => [home, local]));
      const here = new Set(memory.facts.map((fact) => fact.id));
      const carried: Record<string, string> = {};
      const returned = new Set<string>();
      const arrived: { id: string; text: string; createdAt: number }[] = [];
      for (const fact of incoming) {
        let id = localOf.get(fact.id);
        const origin = fact.origin;
        // Also after a send that seemed to fail: then it is no longer marked forwarded.
        if (
          id === undefined &&
          origin !== undefined &&
          !(origin in guest.carried) &&
          (here.has(origin) || guest.forwarded.includes(origin))
        ) {
          id = origin;
          returned.add(origin);
          // Forgotten here before it came back: kept as carried, so the forget goes home.
          if (!here.has(origin)) {
            carried[origin] = fact.id;
            continue;
          }
        }
        id ??= `p${memory.next++}`;
        carried[id] = fact.id;
        arrived.push({ id, text: fact.text, createdAt: fact.createdAt });
      }
      const kept = memory.facts
        .filter((fact) => !(fact.id in guest.carried) && !returned.has(fact.id))
        .map((fact) => structuredClone({ ...fact }));
      memory.facts = [...arrived, ...kept].slice(0, MAX_FACTS);
      guest.carry = claim.carry;
      guest.carried = carried;
      guest.forwarded = claim.carry ? guest.forwarded.filter((id) => !returned.has(id)) : [];
    }, context);
    await this.memoryChanged(playerId, context);
  }

  /**
   * Sends a guest's own facts they remembered or forgot here to their home, while it carries
   * their memory. Facts with values someone made private here stay here.
   */
  private async forwardMemory(playerId: string, context: Context): Promise<void> {
    const nudge = this.nudge();
    const player = await nudge.players.get(playerId, context);
    const guest = (await this.state(context)).guests[playerId];
    if (player?.home === undefined || guest === undefined || !guest.carry) return;
    const { facts } = await nudge.memory.ofPlayer(playerId, context);
    const home: Place = { server: player.home.server, assistant: player.home.assistant };
    const base = { from: this.self, audience: home, playerId: player.home.playerId };
    for (const [local, homeId] of Object.entries(guest.carried)) {
      if (facts.some((fact) => fact.id === local)) continue;
      const sent = await this.send(home, guest, {
        kind: "nudge.forget",
        ...base,
        factId: homeId,
        issuedAt: this.nextSignedAt(),
      } satisfies Static<typeof ForgetClaim>);
      if (sent === true)
        await this.commit((state) => {
          const current = state.guests[playerId];
          if (current !== undefined) delete current.carried[local];
        }, context);
    }
    for (const fact of facts) {
      if (fact.id in guest.carried || guest.forwarded.includes(fact.id)) continue;
      if (fact.privateTo !== undefined) continue;
      const carried = this.carriable(fact.text);
      if (carried === undefined) continue;
      // Marked first, so it isn't sent twice while it is on its way.
      await this.commit((state) => {
        state.guests[playerId]?.forwarded.push(fact.id);
      }, context);
      const sent = await this.send(home, guest, {
        kind: "nudge.remember",
        ...base,
        factId: fact.id,
        fact: carried,
        issuedAt: this.nextSignedAt(),
      } satisfies Static<typeof RememberClaim>);
      if (sent !== true)
        await this.commit((state) => {
          const current = state.guests[playerId];
          if (current !== undefined)
            current.forwarded = current.forwarded.filter((id) => id !== fact.id);
        }, context);
    }
  }

  /** Sends a player's profile to every assistant they joined; those that don't know them are dropped. */
  private async sendProfile(playerId: string, context: Context): Promise<void> {
    const memberships = (await this.state(context)).memberships[playerId] ?? [];
    if (memberships.length === 0) return;
    const profile = await this.nudge().profiles.get(playerId, context);
    if (profile === undefined) return;
    const issuedAt = this.nextSignedAt();
    const gone: Place[] = [];
    for (const membership of memberships) {
      const sent = await this.send(membership, membership, {
        kind: "nudge.profile",
        home: { ...this.self, playerId },
        audience: placeOf(membership),
        profile,
        issuedAt,
      } satisfies Static<typeof ProfileClaim>);
      if (sent === "gone") gone.push(membership);
    }
    await this.dropMemberships(playerId, gone, context);
  }

  /**
   * Sends a player's own memory to the places they carry it to, or only to `only`; with
   * `stopping`, tells `only` it is no longer carried.
   */
  private async sendMemory(
    playerId: string,
    only: Place | undefined,
    context: Context,
    { stopping = false }: { stopping?: boolean } = {},
  ): Promise<void> {
    const memberships = ((await this.state(context)).memberships[playerId] ?? []).filter(
      (membership) => (only === undefined ? membership.carry : samePlace(membership, only)),
    );
    if (memberships.length === 0) return;
    const { facts } = await this.nudge().memory.ofPlayer(playerId, context);
    const carried = facts.flatMap((fact) => {
      if (fact.privateTo !== undefined) return [];
      const found = this.carriable(fact.text);
      return found === undefined ? [] : [{ ...found, id: fact.id, createdAt: fact.createdAt }];
    });
    await this.forgetOrigins(playerId, new Set(facts.map((fact) => fact.id)), context);
    const issuedAt = this.nextSignedAt();
    const gone: Place[] = [];
    for (const membership of memberships) {
      const carry = membership.carry && !stopping;
      const sent = await this.send(membership, membership, {
        kind: "nudge.memory",
        home: { ...this.self, playerId },
        audience: placeOf(membership),
        carry,
        facts: carry
          ? carried.map((fact) => {
              const origin = membership.origins?.[fact.id];
              return origin === undefined ? fact : { ...fact, origin };
            })
          : [],
        issuedAt,
      } satisfies Static<typeof MemoryClaim>);
      if (sent === "gone") gone.push(membership);
    }
    await this.dropMemberships(playerId, gone, context);
  }

  /** Drops where facts came from once the player no longer has them. */
  private async forgetOrigins(
    playerId: string,
    kept: Set<string>,
    context: Context,
  ): Promise<void> {
    const stale = ((await this.state(context)).memberships[playerId] ?? []).some((membership) =>
      Object.keys(membership.origins ?? {}).some((id) => !kept.has(id)),
    );
    if (!stale) return;
    await this.commit((state) => {
      for (const membership of state.memberships[playerId] ?? [])
        if (membership.origins !== undefined)
          membership.origins = Object.fromEntries(
            Object.entries(membership.origins).filter(([id]) => kept.has(id)),
          );
    }, context);
  }

  /**
   * A fact with the values behind its placeholders, to carry to another assistant; undefined when
   * it holds a value someone made private, one that was forgotten, or one this vault doesn't know.
   */
  private carriable(text: string): CarriedFact | undefined {
    const entries = this.nudge().valuesIn(text);
    const placeholders = new Set(text.match(PLACEHOLDER) ?? []);
    if (entries.length !== placeholders.size) return undefined;
    if (entries.some((entry) => entry.owner !== undefined || entry.forgotten === true))
      return undefined;
    return {
      text,
      values: entries.map(({ placeholder, value, kind }) => ({ placeholder, value, kind })),
    };
  }

  /**
   * A carried fact as this assistant keeps it: each value protected in its vault, so the model
   * here only sees placeholders of its own. Undefined when a placeholder came without its value.
   */
  private async protectFact(fact: CarriedFact): Promise<string | undefined> {
    const own = new Set(fact.values.map(({ placeholder }) => placeholder));
    if ((fact.text.match(PLACEHOLDER) ?? []).some((placeholder) => !own.has(placeholder)))
      return undefined;
    const nudge = this.nudge();
    let text = fact.text;
    for (const { placeholder, value, kind } of fact.values) {
      if (!/^⟦[A-Z]+\d+⟧$/.test(placeholder) || !/^[A-Z]+$/.test(kind) || value === "")
        return undefined;
      text = text.split(placeholder).join(await nudge.protect(value, kind));
    }
    text = nudge.redact(text);
    await nudge.saveVault();
    return text;
  }

  /**
   * Signs `claim` and sends it, encrypted, to `place`'s inbox. True when it took it, "gone" when
   * it doesn't know who it is about, false when it failed otherwise.
   */
  private async send(place: Place, keys: Keys, claim: unknown): Promise<boolean | "gone"> {
    try {
      const response = await this.fetch(federationEndpoint(place, "/inbox"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: seal(this.signingKey, keys.encryptionKey, claim) }),
      });
      if (response.ok) return true;
      if (response.status === 404) return "gone";
      this.report(new Error(`${place.server} answered ${response.status}`));
    } catch (error) {
      this.report(error);
    }
    return false;
  }

  private async dropMemberships(playerId: string, gone: Place[], context: Context): Promise<void> {
    if (gone.length === 0) return;
    await this.commit((state) => {
      state.memberships[playerId] = (state.memberships[playerId] ?? []).filter(
        (membership) => !gone.some((place) => samePlace(place, membership)),
      );
    }, context);
  }

  /** Every room the player is in may show their own facts. */
  private async memoryChanged(playerId: string, context: Context): Promise<void> {
    const nudge = this.nudge();
    for (const room of await nudge.rooms.list(context, playerId))
      nudge.changes.emit({ kind: "memory", roomId: room.id });
    nudge.changes.emit({ kind: "player-memory", playerId });
  }

  /**
   * What `signed` says, and the keys it was checked with, if `place` signed it with the key pinned
   * for it, or with one that key signed for in a rotation. Then the new keys are pinned instead,
   * everywhere the old one was.
   */
  private async checkFrom(
    place: Place,
    pinned: Keys,
    signed: Signed,
    context: Context,
  ): Promise<{ claim: unknown; keys: Keys } | undefined> {
    const claim = checkSigned(pinned.signingKey, signed);
    if (claim !== undefined) return { claim, keys: pinned };
    const keys = await this.keysOf(placeOf(place), pinned.signingKey);
    if (keys === undefined || keys.signingKey === pinned.signingKey) return undefined;
    const rotated = checkSigned(keys.signingKey, signed);
    if (rotated === undefined) return undefined;
    await this.commit((state) => {
      const all = [...Object.values(state.guests), ...Object.values(state.memberships).flat()];
      for (const held of all)
        if (held.signingKey === pinned.signingKey) {
          held.signingKey = keys.signingKey;
          held.encryptionKey = keys.encryptionKey;
        }
    }, context);
    return { claim: rotated, keys };
  }

  /**
   * The keys `place` publishes, if it answers for itself. With `from`, only when its rotations
   * lead from that signing key to them.
   */
  private keysOf(place: Place, from?: string): Promise<Keys | undefined> {
    return fetchKeys(placeOf(place), this.fetch, {
      ...(from === undefined ? {} : { from }),
      report: this.report,
    });
  }

  private nextSignedAt(): number {
    this.signedAt = Math.max(this.host.now(), this.signedAt + 1);
    return this.signedAt;
  }

  private nudge(): Nudge {
    return this.host.assistant();
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

function trimmed(server: string): string {
  return server.replace(/\/+$/, "");
}

function trimmedPlace(place: Place): Place {
  return { server: trimmed(place.server), assistant: place.assistant };
}

function placeOf(place: Place): Place {
  return { server: place.server, assistant: place.assistant };
}

/** A membership as its player sees it: without the keys. */
function shownServer(owned: OwnedServer): ShownOwnedServer {
  return { server: owned.server, since: owned.since };
}

function shown(membership: Membership): ShownMembership {
  return {
    server: membership.server,
    assistant: membership.assistant,
    since: membership.since,
    carryMemory: membership.carry,
  };
}

function toInvite(invite: Invite): ShownInvite {
  return {
    id: invite.id,
    address: addressOf(invite.home),
    by: invite.by,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  };
}

export default federationExtension();

/** Whether a server's address is reached encrypted: HTTPS, or Wired (`*.wired`). */
function secureServer(server: string): boolean {
  if (server.startsWith("https://")) return true;
  try {
    return isWiredHost(new URL(server).hostname);
  } catch {
    return false;
  }
}
