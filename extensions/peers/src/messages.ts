import { Type } from "@nudge/core";

/** What linked assistants send each other, sealed and signed through federation's channel. */

const PlaceBody = Type.Object({ server: Type.String(), assistant: Type.String() });

/** One assistant → another: an admin there wants the two linked. */
export const LinkClaim = Type.Object({
  kind: Type.Literal("nudge.peer.link"),
  from: PlaceBody,
  audience: PlaceBody,
  displayName: Type.String({ minLength: 1, maxLength: 100 }),
  note: Type.Optional(Type.String({ maxLength: 1000 })),
  issuedAt: Type.Number(),
});

/** The answer to a link: an admin here agreed. */
export const LinkedClaim = Type.Object({
  kind: Type.Literal("nudge.peer.linked"),
  from: PlaceBody,
  audience: PlaceBody,
  displayName: Type.String({ minLength: 1, maxLength: 100 }),
  issuedAt: Type.Number(),
});

/** Either side: the link ends, or a request for one was turned down. */
export const UnlinkClaim = Type.Object({
  kind: Type.Literal("nudge.peer.unlink"),
  from: PlaceBody,
  audience: PlaceBody,
  issuedAt: Type.Number(),
});

/**
 * A message in a thread. `seq` counts the sender's messages in it from 1. `late` marks one that
 * follows an earlier reply, such as the outcome of an approval its people decided later.
 */
export const SayClaim = Type.Object({
  kind: Type.Literal("nudge.peer.say"),
  from: PlaceBody,
  audience: PlaceBody,
  threadId: Type.String({ minLength: 8, maxLength: 64 }),
  seq: Type.Integer({ minimum: 1 }),
  text: Type.String(),
  late: Type.Optional(Type.Boolean()),
  issuedAt: Type.Number(),
});

/** The side that started a thread ended it. */
export const EndClaim = Type.Object({
  kind: Type.Literal("nudge.peer.end"),
  from: PlaceBody,
  audience: PlaceBody,
  threadId: Type.String({ minLength: 8, maxLength: 64 }),
  issuedAt: Type.Number(),
});
