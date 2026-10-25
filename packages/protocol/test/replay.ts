import type { ConversationView } from "@nudge/core";
import { apply, type Op } from "../src/index.ts";
import recording from "./fixtures/conversation-view.json" with { type: "json" };

/**
 * Ann's view of a recorded run in room "trip" (Ann and Bo), after each commit, oldest first: Ann
 * asks the assistant to remember something, it thinks, calls `remember` and answers; Bo writes
 * meanwhile and waits in the inbox; then a scheduled nudge fires and is answered. The server's
 * `conversation-fixture.test.ts` records it again with `NUDGE_RECORD=1`.
 */
export function replay(): ConversationView[] {
  const views = [recording.view as unknown as ConversationView];
  for (const ops of recording.frames) views.push(apply(views.at(-1)!, ops as unknown as Op[]));
  return views;
}
