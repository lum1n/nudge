import type { WireOp } from "@earendil-works/chord/delta";
import type { ServerFrame } from "@nudge/server";
import recording from "./fixtures/room-view.json" with { type: "json" };
import { type ConversationView, ViewMirror } from "../src/mirror.ts";

/**
 * Ann's `?format=view` stream of a recorded run in room "trip" (Ann and Bo): Ann asks the assistant
 * to remember something, it thinks, calls `remember` and answers; Bo writes meanwhile and waits in
 * the inbox; then a scheduled nudge fires and is answered. `NUDGE_RECORD=1` on the server's
 * `view.test.ts` records it again.
 */
export const frames: ServerFrame[] = [
  { type: "view", value: recording.view as unknown as ConversationView },
  ...recording.frames.map((ops) => ({ type: "ops" as const, ops: ops as unknown as WireOp[] })),
];

/** The mirror after each frame, oldest first. */
export function replay(): ConversationView[] {
  const mirror = new ViewMirror();
  return frames.map((frame) => {
    mirror.receive(frame);
    return mirror.value!;
  });
}
