import { createDAVClient, type DAVCalendar } from "tsdav";
import { type Occurrence, occurrences } from "./ical.ts";

/** One CalDAV account as the extension uses it, its password filled in. */
export type CalendarAccount = {
  readonly id: string;
  /** The CalDAV server, such as `https://caldav.fastmail.com` or `https://caldav.icloud.com`. */
  readonly url: string;
  readonly user: string;
  readonly password: string;
  /** Only the calendars with these names; all when absent. */
  readonly calendars?: readonly string[];
  /** Room ids that may use it; `*` for every room. */
  readonly rooms: readonly string[];
};

export type CalendarInfo = { readonly url: string; readonly name: string };

/** An occurrence and where its event is stored. */
export type CalendarEvent = Occurrence & {
  readonly calendar: CalendarInfo;
  readonly objectUrl: string;
  readonly etag?: string;
};

/** What the tools need from a CalDAV server; tests put a fake in its place. */
export interface CalendarBackend {
  /** The account's event calendars, filtered by its `calendars`, in the server's order. */
  calendars(account: CalendarAccount): Promise<CalendarInfo[]>;
  /** Occurrences overlapping `[from, to)` in every calendar, soonest first. */
  events(
    account: CalendarAccount,
    from: Date,
    to: Date,
    timeZone: string,
  ): Promise<CalendarEvent[]>;
  /** The event stored at `objectUrl`, its first occurrence; undefined when it is gone. */
  event(
    account: CalendarAccount,
    calendar: CalendarInfo,
    objectUrl: string,
    timeZone: string,
  ): Promise<CalendarEvent | undefined>;
  add(
    account: CalendarAccount,
    calendar: CalendarInfo,
    filename: string,
    ics: string,
  ): Promise<void>;
  remove(account: CalendarAccount, objectUrl: string, etag?: string): Promise<void>;
}

type Client = Awaited<ReturnType<typeof createDAVClient>>;

/** CalDAV through tsdav, one client per account, made on first use. */
export class CalDavBackend implements CalendarBackend {
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly found = new Map<string, DAVCalendar[]>();

  async calendars(account: CalendarAccount): Promise<CalendarInfo[]> {
    return (await this.davCalendars(account)).map(info);
  }

  async events(
    account: CalendarAccount,
    from: Date,
    to: Date,
    timeZone: string,
  ): Promise<CalendarEvent[]> {
    const client = await this.client(account);
    const found: CalendarEvent[] = [];
    for (const calendar of await this.davCalendars(account)) {
      const objects = await client.fetchCalendarObjects({
        calendar,
        timeRange: { start: from.toISOString(), end: to.toISOString() },
      });
      for (const object of objects) {
        if (typeof object.data !== "string") continue;
        for (const occurrence of occurrences(object.data, from, to, timeZone))
          found.push({
            ...occurrence,
            calendar: info(calendar),
            objectUrl: object.url,
            ...(object.etag === undefined ? {} : { etag: object.etag }),
          });
      }
    }
    return found.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async event(
    account: CalendarAccount,
    calendar: CalendarInfo,
    objectUrl: string,
    timeZone: string,
  ): Promise<CalendarEvent | undefined> {
    const client = await this.client(account);
    const [object] = await client.fetchCalendarObjects({
      calendar: { url: calendar.url },
      objectUrls: [objectUrl],
    });
    if (object === undefined || typeof object.data !== "string") return undefined;
    const [first] = occurrences(
      object.data,
      new Date(0),
      new Date(8_640_000_000_000_000),
      timeZone,
    );
    return first === undefined
      ? undefined
      : {
          ...first,
          calendar,
          objectUrl: object.url,
          ...(object.etag === undefined ? {} : { etag: object.etag }),
        };
  }

  async add(
    account: CalendarAccount,
    calendar: CalendarInfo,
    filename: string,
    ics: string,
  ): Promise<void> {
    const client = await this.client(account);
    const response = await client.createCalendarObject({
      calendar: { url: calendar.url },
      filename,
      iCalString: ics,
    });
    if (!response.ok)
      throw new Error(`The calendar server answered ${response.status} ${response.statusText}`);
  }

  async remove(account: CalendarAccount, objectUrl: string, etag?: string): Promise<void> {
    const client = await this.client(account);
    const response = await client.deleteCalendarObject({
      calendarObject: { url: objectUrl, ...(etag === undefined ? {} : { etag }) },
    });
    if (!response.ok && response.status !== 404)
      throw new Error(`The calendar server answered ${response.status} ${response.statusText}`);
  }

  private client(account: CalendarAccount): Promise<Client> {
    let client = this.clients.get(account.id);
    if (client === undefined) {
      client = createDAVClient({
        serverUrl: account.url,
        credentials: { username: account.user, password: account.password },
        authMethod: "Basic",
        defaultAccountType: "caldav",
      });
      // A failed login is tried again next time, not remembered.
      client.catch(() => this.clients.delete(account.id));
      this.clients.set(account.id, client);
    }
    return client;
  }

  private async davCalendars(account: CalendarAccount): Promise<DAVCalendar[]> {
    const known = this.found.get(account.id);
    if (known !== undefined) return known;
    const all = await (await this.client(account)).fetchCalendars();
    const calendars = all.filter(
      (calendar) =>
        (calendar.components === undefined || calendar.components.includes("VEVENT")) &&
        (account.calendars === undefined || account.calendars.includes(info(calendar).name)),
    );
    this.found.set(account.id, calendars);
    return calendars;
  }
}

function info(calendar: DAVCalendar): CalendarInfo {
  const name =
    typeof calendar.displayName === "string" && calendar.displayName !== ""
      ? calendar.displayName
      : calendar.url;
  return { url: calendar.url, name };
}
