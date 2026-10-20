import { Type } from "@nudge/core";
import { PlaceRequest } from "@nudge/protocol";

/** What goes between assistants. The bodies of the routes apps call are in `@nudge/protocol`. */

export const PlaceBody = PlaceRequest;

const HomeBody = Type.Object({
  server: Type.String(),
  assistant: Type.String(),
  playerId: Type.String(),
});

export const ProfileBody = Type.Object({
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

/** A fact with the values its placeholders stand for, so the receiver can protect them anew. */
export const FactBody = Type.Object({
  text: Type.String(),
  values: Type.Array(
    Type.Object({ placeholder: Type.String(), value: Type.String(), kind: Type.String() }),
  ),
});

const SignedBody = Type.Object({ payload: Type.String(), signature: Type.String() });

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

/** Home → app → the assistant joined: who they are, and their profile. */
export const JoinClaim = Type.Object({
  kind: Type.Literal("nudge.join"),
  home: HomeBody,
  audience: PlaceBody,
  profile: ProfileBody,
  issuedAt: Type.Number(),
  expiresAt: Type.Number(),
  nonce: Type.String({ minLength: 16 }),
});

/**
 * Home → app → a server one of its people owns: they are who the owner there is, for a server
 * token (ADR 11). Unlike a join, it makes no membership.
 */
export const OwnerClaim = Type.Object({
  kind: Type.Literal("nudge.owner"),
  home: HomeBody,
  audience: PlaceBody,
  issuedAt: Type.Number(),
  expiresAt: Type.Number(),
  nonce: Type.String({ minLength: 16 }),
});

/** Home → an assistant one of its people joined: their profile, whole. */
export const ProfileClaim = Type.Object({
  kind: Type.Literal("nudge.profile"),
  home: HomeBody,
  audience: PlaceBody,
  profile: ProfileBody,
  issuedAt: Type.Number(),
});

/** Home → an assistant one of its people joined: their own memory, whole, or that it stops. */
export const MemoryClaim = Type.Object({
  kind: Type.Literal("nudge.memory"),
  home: HomeBody,
  audience: PlaceBody,
  carry: Type.Boolean(),
  facts: Type.Array(
    Type.Intersect([
      FactBody,
      Type.Object({
        id: Type.String(),
        createdAt: Type.Number(),
        /** The fact's id at the receiver, when the person remembered it there. */
        origin: Type.Optional(Type.String()),
      }),
    ]),
  ),
  issuedAt: Type.Number(),
});

/** Home → an assistant one of its people joined: they left it, so their tokens there stop. */
export const LeaveClaim = Type.Object({
  kind: Type.Literal("nudge.leave"),
  home: HomeBody,
  audience: PlaceBody,
  issuedAt: Type.Number(),
});

/** An assistant someone joined → their home: a fact they remembered there, for all of them. */
export const RememberClaim = Type.Object({
  kind: Type.Literal("nudge.remember"),
  from: PlaceBody,
  audience: PlaceBody,
  playerId: Type.String(),
  /** Its id at the sender, which the home names as the fact's `origin` when it carries it back. */
  factId: Type.String(),
  fact: FactBody,
  issuedAt: Type.Number(),
});

/** An assistant someone joined → their home: one of their own facts they forgot there. */
export const ForgetClaim = Type.Object({
  kind: Type.Literal("nudge.forget"),
  from: PlaceBody,
  audience: PlaceBody,
  playerId: Type.String(),
  factId: Type.String(),
  issuedAt: Type.Number(),
});

/** An assistant someone joined → their home: it is being deleted, so their membership there ends. */
export const ClosedClaim = Type.Object({
  kind: Type.Literal("nudge.closed"),
  from: PlaceBody,
  audience: PlaceBody,
  playerId: Type.String(),
  issuedAt: Type.Number(),
});
