import type { RoomView } from "@nudge/client";
import type { Mood } from "./pose.ts";

/** After this long with nothing said in the room, the robot dozes off. */
export const ASLEEP_AFTER = 30 * 60_000;

/**
 * What the robot shows for a room, from what is going on in it at `now` (ms since the epoch):
 * someone dictating, an approval waiting, the turn running and what it is doing, or how long it
 * has been quiet. How a turn ended is `ended`'s to say.
 */
export function moodOf(
  view: Pick<RoomView, "timeline" | "live" | "approvals">,
  now: number,
  { listening = false }: { listening?: boolean } = {},
): Mood {
  if (listening) return "listening";
  if (view.approvals.some((approval) => approval.status === "pending")) return "waiting";
  if (view.live.status?.kind === "retrying") return "puzzled";
  if (view.live.status?.kind === "compacting") return "thinking";
  if (view.live.running) {
    const answer = view.timeline.findLast((item) => item.type === "answer");
    const last = answer?.status === "running" ? answer.parts.at(-1) : undefined;
    if (last?.type === "tool" && last.status !== "done") return "working";
    if (last?.type === "text" && last.text !== "") return "speaking";
    return "thinking";
  }
  return now - lastSaid(view.timeline) > ASLEEP_AFTER ? "asleep" : "idle";
}

/** When something was last said in the room, in ms since the epoch; 0 for a room without times. */
function lastSaid(timeline: RoomView["timeline"]): number {
  let at = 0;
  for (const item of timeline) {
    if (item.type === "user" && item.sentAt !== undefined) at = Math.max(at, item.sentAt);
    if (item.type === "nudge") at = Math.max(at, item.firedAt);
    if (item.type === "answer" && item.startedAt !== undefined) at = Math.max(at, item.startedAt);
  }
  // A room with no times at all is a new one, not a sleepy one.
  return at === 0 ? Number.POSITIVE_INFINITY : at;
}

/**
 * The mood a turn ends with, shown for a moment, when the room's last answer goes from running to
 * `status`; undefined while it runs, or for a stopped one.
 */
export function ended(status: "running" | "done" | "stopped" | "failed"): Mood | undefined {
  if (status === "done") return "happy";
  if (status === "failed") return "sad";
  return undefined;
}

/** How long the end of a turn shows, in ms. */
export const AFTERGLOW: Partial<Record<Mood, number>> = { happy: 1600, sad: 4000 };
