import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { checkSigned } from "./signing.ts";

/** A party's public keys: Ed25519 to check what it signs, X25519 to seal messages for it. */
export type Keys = { signingKey: string; encryptionKey: string };

const SignedBody = Type.Object({ payload: Type.String(), signature: Type.String() });

/** Who someone is at their home: its server and assistant, and their id there. */
export const HomeBody = Type.Object({
  server: Type.String(),
  assistant: Type.String(),
  playerId: Type.String(),
});

/** An assistant's old signing key → anyone: these are its keys now. */
export const KeysClaim = Type.Object({
  kind: Type.Literal("nudge.keys"),
  server: Type.String(),
  assistant: Type.String(),
  signingKey: Type.String(),
  encryptionKey: Type.String(),
  issuedAt: Type.Number(),
});

/**
 * The keys an assistant publishes at `GET /key`, with its latest rotations, oldest first: each a
 * `KeysClaim` signed by the signing key before it, so whoever pinned an old key can follow it here.
 */
export const KeysBody = Type.Object({
  server: Type.String(),
  assistant: Type.String(),
  signingKey: Type.String(),
  encryptionKey: Type.String(),
  rotations: Type.Optional(Type.Array(SignedBody)),
});

/**
 * Home → app → a server one of its people owns: they are who that owner is, for a server token
 * (ADR 11). For the server whose own signing key is `audience.key`, so another server it is
 * forwarded to refuses it. Unlike a join, it makes no membership.
 */
export const OwnerClaim = Type.Object({
  kind: Type.Literal("nudge.owner"),
  home: HomeBody,
  audience: Type.Object({ server: Type.String(), key: Type.String() }),
  issuedAt: Type.Number(),
  expiresAt: Type.Number(),
  nonce: Type.String({ minLength: 16 }),
});

/** How long an assertion from home works, for joining or for signing in as an owner. */
export const ASSERTION_TTL_MS = 5 * 60_000;
/** How far apart two hosts' clocks may be. */
export const SKEW_MS = 60_000;

/** An assistant, as federation names it: its server and its name there. */
type Place = { server: string; assistant: string };

/** The URL of the federation route `path` of the assistant at `place`. */
export function federationEndpoint(place: Place, path: string): string {
  return `${place.server}/v1/a/${encodeURIComponent(place.assistant)}/ext/federation${path}`;
}

/**
 * The keys the assistant at `place` publishes, if it answers for itself. With `from`, only when
 * its rotations lead from that signing key to them. Fetch failures go to `report`.
 */
export async function fetchKeys(
  place: Place,
  fetcher: typeof fetch,
  { from, report }: { from?: string; report?: (error: unknown) => void } = {},
): Promise<Keys | undefined> {
  let body: unknown;
  try {
    const response = await fetcher(federationEndpoint(place, "/key"));
    if (!response.ok) return undefined;
    body = await response.json();
  } catch (error) {
    report?.(error);
    return undefined;
  }
  if (!Value.Check(KeysBody, body) || !samePlace(body, place)) return undefined;
  const keys = { signingKey: body.signingKey, encryptionKey: body.encryptionKey };
  return from === undefined || from === keys.signingKey || rotatedTo(body, from) ? keys : undefined;
}

/** Whether `body`'s rotations lead, unbroken, from the signing key `from` to its keys. */
function rotatedTo(body: Static<typeof KeysBody>, from: string): boolean {
  let signer: string | undefined;
  let last: Keys | undefined;
  for (const rotation of body.rotations ?? []) {
    // The chain starts where the pinned key signed, and goes on unbroken from there.
    const claim = checkSigned(signer ?? from, rotation);
    if (!Value.Check(KeysClaim, claim) || !samePlace(claim, body)) {
      if (signer === undefined) continue;
      return false;
    }
    signer = claim.signingKey;
    last = { signingKey: claim.signingKey, encryptionKey: claim.encryptionKey };
  }
  return last?.signingKey === body.signingKey && last.encryptionKey === body.encryptionKey;
}

function samePlace(a: Place, b: Place): boolean {
  return (
    a.server.replace(/\/+$/, "") === b.server.replace(/\/+$/, "") && a.assistant === b.assistant
  );
}
