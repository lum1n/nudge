import type { Owner } from "../privacy/turn.ts";
import { defineDoc } from "@earendil-works/pi-durable";

// Stored in a document, so plain JSON.
export type ScheduledNudge = {
  /** The timer task's id, as a string. */
  id: string;
  roomId: string;
  conversationId: number;
  /** What the assistant is asked to deliver. */
  message: string;
  /** Next time it fires, in ms on the assistant's clock. */
  fireAt: number;
  /** Repeat interval in ms; absent for a one-off. */
  every?: number;
  createdAt: number;
  /** Set in answer to something private: only this player sees it, and what it leads to. */
  privateTo?: Owner;
  /**
   * Whose turn scheduled it: when it fires, its tools get this player's values, as that turn's did.
   * Absent for nudges stored before it was kept, and for those scheduled in a turn that acted for
   * nobody; those get only the values nobody owns.
   */
  scheduledBy?: Owner;
};

export type ScheduleState = {
  /** Pending nudges by id. A one-off leaves when it fires; any nudge leaves when cancelled. */
  nudges: Record<string, ScheduledNudge>;
};

/** Every pending nudge of the assistant, so they can be listed without scanning tasks. */
export const ScheduleDoc = defineDoc<ScheduleState>({
  kind: "nudge.schedule",
  version: 1,
  scope: "session",
  initial: () => ({ nudges: {} }),
  // Stored whole on every change, so what was forgotten leaves no older revision (ADR 9).
  checkpointWhen: () => true,
});

/** The first time after `now` a nudge that was due at `fireAt` fires again; missed repeats are skipped. */
export function nextFire(fireAt: number, every: number, now: number): number {
  if (fireAt + every > now) return fireAt + every;
  return fireAt + every * (Math.floor((now - fireAt) / every) + 1);
}

const LOCAL_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * `2026-10-13T14:30`, `2026-10-13 14:30:00` or with an offset (`Z`, `+02:00`), as ms. Times without an
 * offset are wall-clock times in `timeZone`. Undefined when `text` is none of those.
 */
export function parseTime(text: string, timeZone: string): number | undefined {
  const match = LOCAL_TIME.exec(text.trim());
  if (match === null) return undefined;
  const [, y, mo, d, h, mi, s, offset] = match;
  const fields = [y, mo, d, h, mi, s ?? "0"].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [year, month, day, hour, minute, second] = fields;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
    return undefined;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  if (offset === "Z") return wall;
  if (offset !== undefined) {
    const digits = offset.replace(":", "");
    const minutes = Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5));
    return wall - (offset.startsWith("-") ? -minutes : minutes) * 60_000;
  }
  // The zone's offset at the guess, then again at the answer, which settles around DST changes.
  const first = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(first, timeZone);
}

/** How far `timeZone`'s wall clock is ahead of UTC at `time`, in ms. */
function zoneOffset(time: number, timeZone: string): number {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(time)
      .map((part) => [part.type, Number(part.value)]),
  );
  const { year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = parts;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  return wall - Math.floor(time / 1000) * 1000;
}

/** `Tuesday 13 October 2026, 14:30` in `timeZone`. */
export function formatTime(time: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(time);
}
