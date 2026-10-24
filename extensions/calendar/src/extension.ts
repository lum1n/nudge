import { fillVariables } from "@nudge/bridge";
import {
  defineNudgeExtension,
  defineTool,
  parseTime,
  readsOnly,
  requestApproval,
  roomOf,
  roomsSetting,
  section,
  Type,
} from "@nudge/core";
import {
  CalDavBackend,
  type CalendarAccount,
  type CalendarBackend,
  type CalendarEvent,
  type CalendarInfo,
} from "./backend.ts";
import { buildEvent } from "./ical.ts";

const VERSION = "0.1.0";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const AccountSettings = Type.Object({
  id: Type.String({
    pattern: "^[a-z0-9][a-z0-9-]*$",
    description: "A short name for the account, in lowercase letters, digits and dashes.",
  }),
  url: Type.String({
    pattern: "^https?://",
    title: "CalDAV URL",
    description: "The address of the CalDAV server, starting with http:// or https://.",
  }),
  user: Type.String({
    description: "The user name to log in with; ${NAME} takes it from an environment variable.",
  }),
  /** `${NAME}` takes it from the host's environment, so it stays out of nudge.json. */
  password: Type.String({
    description:
      "The password to log in with; write ${NAME} to take it from an environment variable instead.",
  }),
  calendars: Type.Optional(
    Type.Array(Type.String(), {
      description: "Use only the calendars with these names; leave empty for all of them.",
    }),
  ),
  /** Room ids that may use the account; `*` for every room. */
  rooms: roomsSetting({ title: "Rooms", description: "The rooms that may use this account." }),
});

const Settings = Type.Object({
  accounts: Type.Array(AccountSettings, {
    default: [],
    description: "The CalDAV accounts the assistant can read and add events to.",
  }),
});

type AddPayload = {
  readonly account: string;
  readonly calendar: CalendarInfo;
  readonly filename: string;
  readonly ics: string;
};
type RemovePayload = {
  readonly account: string;
  readonly objectUrl: string;
  readonly etag?: string;
};

export type CalendarOptions = {
  /** The CalDAV servers; tests pass a fake. */
  readonly backend?: CalendarBackend;
};

/** The calendar extension with its backend chosen; the default export uses CalDAV. */
export function calendarExtension(options: CalendarOptions = {}) {
  return defineNudgeExtension({
    name: "calendar",
    version: VERSION,
    apiVersion: "1.0",
    description: "Read CalDAV calendars; add and remove events once someone in the room approves.",
    settings: Settings,
    setup: (host) => {
      const backend = options.backend ?? new CalDavBackend();
      const { timeZone } = host;
      const accounts: CalendarAccount[] = host.settings.accounts.map((account) => ({
        ...account,
        user: fillVariables(account.user, process.env, "calendar"),
        password: fillVariables(account.password, process.env, "calendar"),
      }));
      const usableIn = (roomId: string) =>
        accounts.filter((account) => account.rooms.includes("*") || account.rooms.includes(roomId));
      const text = (value: string, isError = false) => ({
        output: [{ type: "text" as const, text: value }],
        ...(isError ? { isError } : {}),
      });
      const pick = (roomId: string, id: string | undefined): CalendarAccount | string => {
        const usable = usableIn(roomId);
        if (usable.length === 0) return "No calendar is set up for this conversation.";
        if (id === undefined) return usable[0]!;
        return (
          usable.find((account) => account.id === id) ??
          `No calendar account "${id}" here; there is ${usable.map((a) => a.id).join(", ")}.`
        );
      };
      const accountParameter = Type.Optional(
        Type.String({ description: "Account id; default the first one here." }),
      );
      /** `c<n>:<file>`: the calendar's place in the account's list, and the event's file in it. */
      const idOf = async (account: CalendarAccount, event: CalendarEvent) => {
        const calendars = await backend.calendars(account);
        const index = calendars.findIndex((calendar) => calendar.url === event.calendar.url);
        return `c${index}:${decodeURIComponent(event.objectUrl.split("/").filter(Boolean).at(-1) ?? "")}`;
      };

      const list = defineTool({
        name: "calendar_events",
        description:
          "List calendar events from a day on, recurring ones expanded, with each event's id for " +
          "calendar_remove. Times are local.",
        parameters: Type.Object({
          account: accountParameter,
          from: Type.Optional(
            Type.String({ description: "First day, like 2026-10-15; default today." }),
          ),
          days: Type.Optional(Type.Number({ description: "How many days; default 7, up to 62." })),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          const account = pick(room.id, args.account);
          if (typeof account === "string") return text(account, true);
          const from =
            args.from === undefined
              ? startOfDay(host.now(), timeZone)
              : parseDay(args.from, timeZone);
          if (from === undefined)
            return text(`Could not read the day "${args.from}"; use 2026-10-15.`, true);
          const days = Math.min(Math.max(1, Math.round(args.days ?? 7)), 62);
          const events = await backend.events(
            account,
            new Date(from),
            new Date(from + days * DAY),
            timeZone,
          );
          if (events.length === 0) return text(`No events in those ${days} days.`);
          const lines = [];
          for (const event of events)
            lines.push(
              `${await idOf(account, event)}  ${when(event, timeZone)}  ${event.title}` +
                (event.location === undefined ? "" : ` @ ${event.location}`) +
                ` (${event.calendar.name}${event.recurring ? ", repeats" : ""})`,
            );
          return text(lines.join("\n"));
        },
      });

      const add = defineTool({
        name: "calendar_add",
        description:
          "Add an event to a calendar this conversation may use. It waits for someone in the room " +
          "to approve it; say so. A start without a time makes an all-day event.",
        parameters: Type.Object({
          account: accountParameter,
          calendar: Type.Optional(
            Type.String({ description: "Calendar name; default the first." }),
          ),
          title: Type.String(),
          start: Type.String({
            description: `Local time in ${timeZone}, like 2026-10-15T18:00, or a day.`,
          }),
          end: Type.Optional(
            Type.String({ description: "Default an hour later, or the day after." }),
          ),
          location: Type.Optional(Type.String()),
          notes: Type.Optional(Type.String()),
        }),
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          const account = pick(room.id, args.account);
          if (typeof account === "string") return text(account, true);
          const calendars = await backend.calendars(account);
          const calendar =
            args.calendar === undefined
              ? calendars[0]
              : calendars.find((c) => c.name.toLowerCase() === args.calendar!.toLowerCase());
          if (calendar === undefined)
            return text(
              `No calendar "${args.calendar ?? ""}"; there is ${calendars.map((c) => c.name).join(", ")}.`,
              true,
            );
          const start = parseWhen(args.start, timeZone);
          if (start === undefined) return text(`Could not read the start "${args.start}".`, true);
          const end =
            args.end === undefined
              ? { at: start.at + (start.allDay ? DAY : HOUR), allDay: start.allDay }
              : parseWhen(args.end, timeZone);
          if (end === undefined) return text(`Could not read the end "${args.end}".`, true);
          if (end.allDay !== start.allDay)
            return text("Give start and end both with times, or both without.", true);
          // An all-day end is the day after the last day; a day given as the end means that day too.
          const endAt = start.allDay && args.end !== undefined ? end.at + DAY : end.at;
          if (endAt <= start.at) return text("The end is before the start.", true);
          const event = {
            title: args.title,
            start: new Date(start.at),
            end: new Date(endAt),
            allDay: start.allDay,
            ...(args.location === undefined ? {} : { location: args.location }),
            ...(args.notes === undefined ? {} : { notes: args.notes }),
          };
          const { uid, ics } = buildEvent(event, timeZone, new Date(host.now()));
          const payload: AddPayload = {
            account: account.id,
            calendar,
            filename: `${uid}.ics`,
            ics,
          };
          const approval = await api.commit(
            (tx) =>
              requestApproval(
                tx,
                room.id,
                {
                  extension: "calendar",
                  kind: "add",
                  summary:
                    `Add "${args.title}" to the calendar ${calendar.name}: ${when(event, timeZone)}` +
                    (args.location === undefined ? "" : ` at ${args.location}`),
                  payload: payload as never,
                },
                host.now(),
              ),
            context,
          );
          return {
            output: [
              {
                type: "text" as const,
                text: `Waiting for someone in the room to approve it (${approval.id}).`,
              },
            ],
            details: { approval: approval.id },
          };
        },
      });

      const remove = defineTool({
        name: "calendar_remove",
        description:
          "Remove an event by its id from calendar_events; for a recurring event, every " +
          "occurrence. It waits for someone in the room to approve it.",
        parameters: Type.Object({ account: accountParameter, id: Type.String() }),
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          const account = pick(room.id, args.account);
          if (typeof account === "string") return text(account, true);
          const match = /^c(\d+):(.+)$/.exec(args.id);
          const calendar =
            match === null ? undefined : (await backend.calendars(account))[Number(match[1])];
          if (match === null || calendar === undefined) return text(`No event ${args.id}.`, true);
          const objectUrl = new URL(
            encodeURIComponent(match[2]!),
            calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`,
          ).href;
          const event = await backend.event(account, calendar, objectUrl, timeZone);
          if (event === undefined)
            return text(`No event ${args.id}; it may be gone already.`, true);
          const payload: RemovePayload = {
            account: account.id,
            objectUrl: event.objectUrl,
            ...(event.etag === undefined ? {} : { etag: event.etag }),
          };
          const approval = await api.commit(
            (tx) =>
              requestApproval(
                tx,
                room.id,
                {
                  extension: "calendar",
                  kind: "remove",
                  summary:
                    `Remove "${event.title}" (${when(event, timeZone)}${event.recurring ? ", and every repeat" : ""}) ` +
                    `from the calendar ${calendar.name}`,
                  payload: payload as never,
                },
                host.now(),
              ),
            context,
          );
          return {
            output: [
              {
                type: "text" as const,
                text: `Waiting for someone in the room to approve it (${approval.id}).`,
              },
            ],
            details: { approval: approval.id },
          };
        },
      });

      return {
        tools: [readsOnly(list), add, remove],
        sections: [
          section("calendar", async (input, context) => {
            const room = await roomOf(input.read, input.conversationId, context).catch(
              () => undefined,
            );
            if (room === undefined) return undefined;
            const usable = usableIn(room.id);
            if (usable.length === 0) return undefined;
            return (
              `Calendars this conversation can read with calendar_events, and change with ` +
              `calendar_add and calendar_remove (changes wait for approval): ${usable.map((a) => a.id).join(", ")}. ` +
              `To remind people of events, schedule a nudge that checks the calendar, such as one ` +
              `every evening that looks at the next day.`
            );
          }),
        ],
        approvals: {
          add: async (payload, run) => {
            const add = payload as unknown as AddPayload;
            const account = usableIn(run.room.id).find((a) => a.id === add.account);
            if (account === undefined)
              return {
                text: `Calendar account ${add.account} isn't available here any more.`,
                isError: true,
              };
            await backend.add(account, add.calendar, add.filename, add.ics);
            return { text: `Added to ${add.calendar.name}.` };
          },
          remove: async (payload, run) => {
            const remove = payload as unknown as RemovePayload;
            const account = usableIn(run.room.id).find((a) => a.id === remove.account);
            if (account === undefined)
              return {
                text: `Calendar account ${remove.account} isn't available here any more.`,
                isError: true,
              };
            await backend.remove(account, remove.objectUrl, remove.etag);
            return { text: "Removed." };
          },
        },
      };
    },
  });
}

/** `Thu 15 Oct 18:00–19:30`, or `Thu 15 Oct` (all day), `Thu 15 – Sat 17 Oct` for several days. */
export function when(
  event: { readonly start: Date; readonly end: Date; readonly allDay: boolean },
  timeZone: string,
): string {
  const day = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(date);
  const time = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  if (event.allDay) {
    const last = new Date(event.end.getTime() - DAY);
    return day(last) === day(event.start)
      ? `${day(event.start)}, all day`
      : `${day(event.start)} – ${day(last)}, all day`;
  }
  return day(event.end) === day(event.start)
    ? `${day(event.start)} ${time(event.start)}–${time(event.end)}`
    : `${day(event.start)} ${time(event.start)} – ${day(event.end)} ${time(event.end)}`;
}

/** A local time, or a day without one (all day, from its midnight). */
function parseWhen(text: string, timeZone: string): { at: number; allDay: boolean } | undefined {
  const day = parseDay(text, timeZone);
  if (day !== undefined) return { at: day, allDay: true };
  const at = parseTime(text, timeZone);
  return at === undefined ? undefined : { at, allDay: false };
}

/** Midnight of `YYYY-MM-DD` in `timeZone`. */
function parseDay(text: string, timeZone: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) return undefined;
  return parseTime(`${text.trim()}T00:00`, timeZone);
}

function startOfDay(now: number, timeZone: string): number {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parseTime(`${day}T00:00`, timeZone)!;
}

export default calendarExtension();
