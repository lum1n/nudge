import { dirname, join, resolve } from "node:path";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { ASSERTION_TTL_MS, fetchKeys, type Keys, OwnerClaim, SKEW_MS } from "../federation/keys.ts";
import {
  checkSigned,
  newKey,
  open,
  peek,
  publicKeyOf,
  type Sealed,
  type Signed,
} from "../federation/signing.ts";
import { addressOf, parseAddress, type PlayerHome } from "../identity/directory.ts";
import { SecretStore } from "../secrets.ts";
import type { ServerOwner, ServerOwners } from "./owners.ts";

/** Where a server keeps its own keys: `server/federation` beside its config. */
export function serverIdentityDir(configPath: string): string {
  return join(dirname(resolve(configPath)), "server", "federation");
}

const SCOPE = "server";

/**
 * The server's own keys (ADR 11), apart from its assistants': owners' homes seal assertions to
 * them, so being an owner needs no assistant here. Made on first use, and kept in a `SecretStore`
 * under the data directory, so they travel in backups.
 */
export class ServerIdentity {
  private readonly store: SecretStore;
  private readonly signingKey: string;
  private readonly encryptionKey: string;

  /** `dir` is `<data directory>/server/federation`; undefined keeps keys in memory, for tests. */
  constructor(dir: string | undefined) {
    this.store = new SecretStore(dir);
    this.signingKey = this.ownKey("signing-key", "ed25519");
    this.encryptionKey = this.ownKey("encryption-key", "x25519");
  }

  /** What `GET /v1/server/key` shows. */
  publicKeys(): Keys {
    return {
      signingKey: publicKeyOf(this.signingKey),
      encryptionKey: publicKeyOf(this.encryptionKey),
    };
  }

  /** The signed message inside `sealed`, if it was sealed for this server. */
  open(sealed: Sealed): Signed | undefined {
    return open(this.encryptionKey, sealed);
  }

  private ownKey(name: string, type: "ed25519" | "x25519"): string {
    let key = this.store.get(SCOPE, name);
    if (key === undefined) {
      key = newKey(type);
      this.store.set(SCOPE, name, key);
    }
    return key;
  }
}

/** Why an assertion signed no one in: 401 when it isn't a good one, 403 when it names no owner. */
export type OwnerSignIn = { owner: ServerOwner } | { status: 401 | 403; error: string };

/** What an owner assertion says, once opened: sealed for this server, for its key, and in time. */
function openOwnerClaim(
  assertion: unknown,
  identity: ServerIdentity,
  now: number,
): { signed: Signed; claim: Static<typeof OwnerClaim> } | undefined {
  if (!isSealed(assertion)) return undefined;
  const signed = identity.open(assertion);
  const claim = signed === undefined ? undefined : peek(signed);
  if (
    signed === undefined ||
    !Value.Check(OwnerClaim, claim) ||
    claim.audience.key !== identity.publicKeys().signingKey ||
    now < claim.issuedAt - SKEW_MS ||
    now > claim.expiresAt ||
    claim.expiresAt - claim.issuedAt > ASSERTION_TTL_MS
  )
    return undefined;
  return { signed, claim };
}

/**
 * The owner an assertion from their home names, once it checks out: sealed for this server, in
 * time, signed by that home's pinned keys (or keys its rotations lead to, then pinned instead, or
 * the first ones it shows, for an owner whose home wasn't reached yet), and used once.
 */
export async function ownerFromHome(
  assertion: unknown,
  {
    identity,
    owners,
    fetch: fetcher,
    now = Date.now(),
  }: { identity: ServerIdentity; owners: ServerOwners; fetch: typeof fetch; now?: number },
): Promise<OwnerSignIn> {
  const refused = { status: 401, error: "That assertion isn't good here" } as const;
  const opened = openOwnerClaim(assertion, identity, now);
  if (opened === undefined) return refused;
  const { signed, claim } = opened;
  const owner = owners.ownerAt(claim.home);
  if (owner === undefined) return { status: 403, error: "Only the server's owners may do that" };
  const home = { server: claim.home.server, assistant: claim.home.assistant };
  let checked = owner.keys === undefined ? undefined : checkSigned(owner.keys.signingKey, signed);
  if (checked === undefined) {
    const keys = await fetchKeys(home, fetcher, owner.keys && { from: owner.keys.signingKey });
    checked = keys === undefined ? undefined : checkSigned(keys.signingKey, signed);
    if (checked === undefined || keys === undefined) return refused;
    owners.repin(owner.id, keys);
  }
  if (!Value.Check(OwnerClaim, checked) || !owners.useNonce(checked.nonce, checked.expiresAt))
    return refused;
  return { owner };
}

/**
 * Who a server set up from their home is started from (ADR 11): the home, and its keys when setup
 * reached it; otherwise its signed assertion, for whoever reaches it first to check.
 */
export type VouchedHome = {
  readonly home: PlayerHome;
  readonly keys?: Keys;
  readonly proof?: Signed;
};

/** An assertion from home that setup won't take. */
export class HomeRefused extends Error {
  override name = "HomeRefused";
}

/**
 * The home an owner assertion sent with setup names, once it checks out: sealed for this server,
 * in time, and used once. Its signature is checked against the home's keys when the home answers
 * within a few seconds; a home this server can't reach yet, as one on a Wired network it isn't in,
 * leaves the assertion as proof, checked when the person first joins from there. Throws when it
 * isn't a good one, with `HomeRefused`.
 */
export async function homeAtSetup(
  assertion: unknown,
  {
    identity,
    owners,
    fetch: fetcher,
    now = Date.now(),
  }: { identity: ServerIdentity; owners: ServerOwners; fetch: typeof fetch; now?: number },
): Promise<VouchedHome> {
  const opened = openOwnerClaim(assertion, identity, now);
  if (opened === undefined) throw new HomeRefused("That assertion from home isn't good here");
  const { signed, claim } = opened;
  const home = {
    server: claim.home.server,
    assistant: claim.home.assistant,
    playerId: claim.home.playerId,
  };
  if (parseAddress(addressOf(home)) === undefined)
    throw new HomeRefused("That assertion from home names no address");
  const keys = await fetchKeys(home, (url) => fetcher(url, { signal: AbortSignal.timeout(5_000) }));
  if (keys !== undefined && !Value.Check(OwnerClaim, checkSigned(keys.signingKey, signed)))
    throw new HomeRefused("The home did not sign that assertion");
  if (!owners.useNonce(claim.nonce, claim.expiresAt))
    throw new HomeRefused("That assertion from home was used already");
  return keys === undefined ? { home, proof: signed } : { home, keys };
}

function isSealed(value: unknown): value is Sealed {
  if (typeof value !== "object" || value === null) return false;
  const sealed = value as Record<string, unknown>;
  return (
    sealed.v === 1 &&
    ["epk", "iv", "data", "tag"].every((field) => typeof sealed[field] === "string")
  );
}
