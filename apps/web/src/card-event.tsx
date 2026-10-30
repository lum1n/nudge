import type { UiBlock } from "@nudge/client";
import { m } from "./i18n/index.ts";

type EventBlock = Extract<UiBlock, { type: "event" }>;

/** A card's calendar event, with a button that gives it to the calendar as an .ics file. */
export function CardEvent(props: { block: EventBlock }) {
  const { block } = props;
  return (
    <div className="flex gap-3 rounded bg-stone-50 px-3 py-2">
      <div className="flex flex-1 flex-col gap-0.5">
        <div className="font-medium">{block.title}</div>
        <div className="text-stone-600">{when(block)}</div>
        {block.location !== undefined && <div className="text-stone-600">{block.location}</div>}
        {block.notes !== undefined && (
          <div className="text-xs whitespace-pre-line text-stone-500">{block.notes}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => download(block)}
        className="self-start rounded border border-stone-300 bg-white px-2 py-0.5"
      >
        {m.room.chat.card.addToCalendar}
      </button>
    </div>
  );
}

const allDay = (value: string) => !value.includes("T");

/** A day as the reader's calendar has it: `2026-11-03` is that day wherever they are. */
function day(value: string): Date {
  const [year, month, date] = value.split("-").map(Number);
  return new Date(year!, month! - 1, date!);
}

function when(block: EventBlock): string {
  if (allDay(block.start)) {
    const format = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });
    const [start, end] = [day(block.start), block.end === undefined ? undefined : day(block.end)];
    return end === undefined || end.getTime() === start.getTime()
      ? format.format(start)
      : format.formatRange(start, end);
  }
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });
  const start = new Date(block.start);
  return block.end === undefined
    ? format.format(start)
    : format.formatRange(start, new Date(block.end));
}

/** The event as an iCalendar file, which the browser hands to the calendar app. */
function download(block: EventBlock) {
  const url = URL.createObjectURL(new Blob([ics(block)], { type: "text/calendar" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${block.title.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "event"}.ics`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ics(block: EventBlock, now = Date.now()): string {
  const utc = (time: number) =>
    new Date(time).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const date = (value: string) => value.replaceAll("-", "");
  const text = (value: string) =>
    value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nudge//Cards//EN",
    "BEGIN:VEVENT",
    `UID:${utc(now)}-${Math.random().toString(36).slice(2)}@nudge`,
    `DTSTAMP:${utc(now)}`,
  ];
  if (allDay(block.start)) {
    // An all-day event ends the day after its last day.
    const last = day(block.end ?? block.start);
    const after = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    lines.push(
      `DTSTART;VALUE=DATE:${date(block.start)}`,
      `DTEND;VALUE=DATE:${after.getFullYear()}${pad(after.getMonth() + 1)}${pad(after.getDate())}`,
    );
  } else {
    lines.push(`DTSTART:${utc(Date.parse(block.start))}`);
    if (block.end !== undefined) lines.push(`DTEND:${utc(Date.parse(block.end))}`);
  }
  lines.push(`SUMMARY:${text(block.title)}`);
  if (block.location !== undefined) lines.push(`LOCATION:${text(block.location)}`);
  if (block.notes !== undefined) lines.push(`DESCRIPTION:${text(block.notes)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
