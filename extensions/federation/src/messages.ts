import { Type } from "@nudge/core";

/** What goes between assistants, and the bodies of the routes that carry it. */

export const SealedBody = Type.Object({
  v: Type.Literal(1),
  epk: Type.String(),
  iv: Type.String(),
  data: Type.String(),
  tag: Type.String(),
});

export const PlaceBody = Type.Object({ server: Type.String(), assistant: Type.String() });

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

/** The keys an assistant publishes at `GET /key`. */
export const KeysBody = Type.Object({
  server: Type.String(),
  assistant: Type.String(),
  signingKey: Type.String(),
  encryptionKey: Type.String(),
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
    Type.Intersect([FactBody, Type.Object({ id: Type.String(), createdAt: Type.Number() })]),
  ),
  issuedAt: Type.Number(),
});

/** An assistant someone joined → their home: a fact they remembered there, for all of them. */
export const RememberClaim = Type.Object({
  kind: Type.Literal("nudge.remember"),
  from: PlaceBody,
  audience: PlaceBody,
  playerId: Type.String(),
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
