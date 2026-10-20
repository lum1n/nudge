import type { RoomView } from "@nudge/client";
import { useEffect, useRef, useState } from "react";
import { AFTERGLOW, ended, moodOf } from "./mood.ts";
import type { Mood } from "./pose.ts";

/** The robot's mood in a room, with a moment of joy or gloom when a turn ends while watching. */
export function useRoomMood(
  view: Pick<RoomView, "timeline" | "live" | "approvals">,
  options: { listening?: boolean } = {},
): Mood {
  const now = useMinute();
  const answer = view.timeline.findLast((item) => item.type === "answer");
  const seen = useRef(answer && { id: answer.id, status: answer.status });
  const [afterglow, setAfterglow] = useState<Mood>();

  useEffect(() => {
    const before = seen.current;
    seen.current = answer && { id: answer.id, status: answer.status };
    if (answer === undefined || before?.id !== answer.id || before.status !== "running") return;
    const mood = ended(answer.status);
    if (mood === undefined) return;
    setAfterglow(mood);
    const timer = setTimeout(() => setAfterglow(undefined), AFTERGLOW[mood]);
    return () => {
      clearTimeout(timer);
      setAfterglow(undefined);
    };
  }, [answer?.id, answer?.status]);

  const mood = moodOf(view, now, options);
  return afterglow !== undefined && mood === "idle" ? afterglow : mood;
}

/** The time, again every minute: enough to notice the room going quiet. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
