import { randomUUID } from "node:crypto";
import ICAL from "ical.js";

/** One occurrence of an event in a time range. */
export type Occurrence = {
  /** The event's UID; every occurrence of a recurring event shares it. */
  readonly uid: string;
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  /** Dates without times: `start` is local midnight of the first day, `end` of the day after. */
  readonly allDay: boolean;
  readonly location?: string;
  readonly notes?: string;
  readonly recurring: boolean;
};

/**
 * Expansions of one recurring event stop here, so a rule without end can't run away. Counted from
 * the event's first start, so it leaves room for a daily one from years back.
 */
const MAX_OCCURRENCES = 10_000;

/**
 * The occurrences of the events in an iCalendar text that overlap `[from, to)`, recurrences
 * expanded. Time zones the text defines are used; all-day events count in `timeZone`'s days.
 */
export function occurrences(ics: string, from: Date, to: Date, timeZone: string): Occurrence[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const zone of root.getAllSubcomponents("vtimezone"))
    ICAL.TimezoneService.register(new ICAL.Timezone(zone));
  const events = root.getAllSubcomponents("vevent").map((component) => new ICAL.Event(component));
  // Changed occurrences (RECURRENCE-ID) replace the ones the rule makes.
  const exceptions = events.filter((event) => event.isRecurrenceException());
  const found: Occurrence[] = [];
  for (const event of events) {
    if (event.isRecurrenceException()) continue;
    for (const exception of exceptions)
      if (exception.uid === event.uid) event.relateException(exception);
    const base = {
      uid: event.uid,
      ...(event.location ? { location: event.location } : {}),
      ...(event.description ? { notes: event.description } : {}),
    };
    if (!event.isRecurring()) {
      const occurrence = toOccurrence(event.startDate, event.endDate, event.summary, timeZone);
      if (overlaps(occurrence, from, to)) found.push({ ...base, ...occurrence, recurring: false });
      continue;
    }
    const iterator = event.iterator();
    for (let n = 0, next = iterator.next(); next !== undefined && n < MAX_OCCURRENCES; n++) {
      const details = event.getOccurrenceDetails(next);
      const occurrence = toOccurrence(
        details.startDate,
        details.endDate,
        details.item.summary,
        timeZone,
      );
      if (occurrence.start >= to) break;
      if (overlaps(occurrence, from, to))
        found.push({
          ...base,
          ...(details.item.location ? { location: details.item.location } : {}),
          ...occurrence,
          recurring: true,
        });
      next = iterator.next();
    }
  }
  return found.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function toOccurrence(
  start: ICAL.Time,
  end: ICAL.Time | undefined,
  title: string,
  timeZone: string,
): Pick<Occurrence, "title" | "start" | "end" | "allDay"> {
  if (start.isDate) {
    const last = end ?? start.clone();
    if (end === undefined) last.day += 1;
    return {
      title,
      start: midnight(start, timeZone),
      end: midnight(last, timeZone),
      allDay: true,
    };
  }
  return { title, start: start.toJSDate(), end: (end ?? start).toJSDate(), allDay: false };
}

/** Midnight of a calendar date in `timeZone`. */
function midnight(date: ICAL.Time, timeZone: string): Date {
  const utc = Date.UTC(date.year, date.month - 1, date.day);
  return new Date(utc - offsetAt(utc, timeZone));
}

/** How far `timeZone` is ahead of UTC at `at`, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) -
    at
  );
}

function overlaps(occurrence: Pick<Occurrence, "start" | "end">, from: Date, to: Date): boolean {
  const end =
    occurrence.end > occurrence.start ? occurrence.end : new Date(occurrence.start.getTime() + 1);
  return occurrence.start < to && end > from;
}

export type NewEvent = {
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly allDay: boolean;
  readonly location?: string;
  readonly notes?: string;
};

/** An iCalendar text with one event, and its UID. All-day dates are taken in `timeZone`. */
export function buildEvent(
  event: NewEvent,
  timeZone: string,
  now = new Date(),
): { readonly uid: string; readonly ics: string } {
  const uid = `${randomUUID()}@nudge`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nudge//Calendar//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utc(now)}`,
    ...(event.allDay
      ? [
          `DTSTART;VALUE=DATE:${localDate(event.start, timeZone)}`,
          `DTEND;VALUE=DATE:${localDate(event.end, timeZone)}`,
        ]
      : [`DTSTART:${utc(event.start)}`, `DTEND:${utc(event.end)}`]),
    `SUMMARY:${escape(event.title)}`,
    ...(event.location === undefined ? [] : [`LOCATION:${escape(event.location)}`]),
    ...(event.notes === undefined ? [] : [`DESCRIPTION:${escape(event.notes)}`]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return { uid, ics: `${lines.flatMap(fold).join("\r\n")}\r\n` };
}

function utc(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replace(/-/g, "");
}

function escape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 octets go on in continuation lines that start with a space (RFC 5545). */
function fold(line: string): string[] {
  const bytes = Buffer.from(line);
  if (bytes.length <= 75) return [line];
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    // Never cut inside a UTF-8 sequence.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push((start === 0 ? "" : " ") + bytes.subarray(start, end).toString());
    start = end;
  }
  return parts;
}
