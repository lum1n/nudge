import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY, type Nudge } from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildEvent,
  type CalendarAccount,
  type CalendarBackend,
  type CalendarEvent,
  type CalendarInfo,
  calendarExtension,
  occurrences,
  when,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const OSLO = "Europe/Oslo";
const by = { playerId: "owner", displayName: "Vegard" };

const FAMILY_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//EN",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Oslo",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  // Football every Tuesday 17:30–19:00 Oslo time since September 2024.
  "BEGIN:VEVENT",
  "UID:football@test",
  "DTSTAMP:20240901T000000Z",
  "DTSTART;TZID=Europe/Oslo:20240903T173000",
  "DTEND;TZID=Europe/Oslo:20240903T190000",
  "RRULE:FREQ=WEEKLY;BYDAY=TU",
  "SUMMARY:Fotball",
  "LOCATION:Banen",
  "END:VEVENT",
  // …but the one on 20 Oct 2026 moved to Wednesday.
  "BEGIN:VEVENT",
  "UID:football@test",
  "DTSTAMP:20240901T000000Z",
  "RECURRENCE-ID;TZID=Europe/Oslo:20261020T173000",
  "DTSTART;TZID=Europe/Oslo:20261021T180000",
  "DTEND;TZID=Europe/Oslo:20261021T193000",
  "SUMMARY:Fotball (flyttet)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:autumn@test",
  "DTSTAMP:20240901T000000Z",
  "DTSTART;VALUE=DATE:20261019",
  "DTEND;VALUE=DATE:20261024",
  "SUMMARY:Høstferie",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("iCalendar", () => {
  it("expands recurrences in a range, with moved occurrences and all-day events in local days", () => {
    const from = new Date("2026-10-18T22:00:00Z"); // Monday 19 Oct, Oslo midnight
    const to = new Date("2026-10-25T23:00:00Z");
    const found = occurrences(FAMILY_ICS, from, to, OSLO);
    expect(found.map((o) => [o.title, when(o, OSLO)])).toEqual([
      ["Høstferie", "Mon 19 Oct – Fri 23 Oct, all day"],
      ["Fotball (flyttet)", "Wed 21 Oct 18:00–19:30"],
    ]);
    // The next week, after the clocks went back: still 17:30 local.
    const later = occurrences(
      FAMILY_ICS,
      new Date("2026-10-26T00:00:00Z"),
      new Date("2026-11-02T00:00:00Z"),
      OSLO,
    );
    expect(later.map((o) => [o.title, when(o, OSLO), o.recurring, o.location])).toEqual([
      ["Fotball", "Tue 27 Oct 17:30–19:00", true, "Banen"],
    ]);
  });

  it("builds an event that reads back the same, folded and escaped", () => {
    const start = new Date("2026-10-22T16:00:00Z");
    const { uid, ics } = buildEvent(
      {
        title: "Foreldremøte, 3B; ta med kaffe",
        start,
        end: new Date("2026-10-22T17:30:00Z"),
        allDay: false,
        notes: `Agenda:\n${"lang tekst med æøå ".repeat(8)}`,
      },
      OSLO,
    );
    expect(uid).toMatch(/@nudge$/);
    expect(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    const [event] = occurrences(ics, new Date("2026-10-01"), new Date("2026-11-01"), OSLO);
    expect(event).toMatchObject({
      uid,
      title: "Foreldremøte, 3B; ta med kaffe",
      start,
      allDay: false,
      notes: `Agenda:\n${"lang tekst med æøå ".repeat(8)}`,
    });
    const allDay = buildEvent(
      {
        title: "Hytta",
        start: new Date("2026-10-30T23:00:00Z"),
        end: new Date("2026-11-01T23:00:00Z"),
        allDay: true,
      },
      OSLO,
    );
    expect(allDay.ics).toContain("DTSTART;VALUE=DATE:20261031");
    expect(allDay.ics).toContain("DTEND;VALUE=DATE:20261102");
  });
});

/** Two calendars in memory. */
class FakeCalendars implements CalendarBackend {
  readonly added: { calendar: string; filename: string; ics: string }[] = [];
  readonly removed: string[] = [];
  readonly list: CalendarInfo[] = [
    { url: "https://dav.example/cal/family/", name: "Familie" },
    { url: "https://dav.example/cal/school/", name: "Skole" },
  ];

  async calendars() {
    return this.list;
  }

  async events(_account: CalendarAccount, from: Date, to: Date, timeZone: string) {
    return occurrences(FAMILY_ICS, from, to, timeZone).map((occurrence): CalendarEvent => ({
      ...occurrence,
      calendar: this.list[0]!,
      objectUrl: `https://dav.example/cal/family/${occurrence.uid.split("@")[0]}.ics`,
      etag: '"1"',
    }));
  }

  async event(
    account: CalendarAccount,
    calendar: CalendarInfo,
    objectUrl: string,
    timeZone: string,
  ) {
    const all = await this.events(
      account,
      new Date("2024-01-01"),
      new Date("2027-01-01"),
      timeZone,
    );
    return all.find(
      (event) => event.objectUrl === objectUrl && event.calendar.url === calendar.url,
    );
  }

  async add(_account: CalendarAccount, calendar: CalendarInfo, filename: string, ics: string) {
    this.added.push({ calendar: calendar.name, filename, ics });
  }

  async remove(_account: CalendarAccount, objectUrl: string) {
    this.removed.push(objectUrl);
  }
}

function lastUser(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "user");
  return typeof message?.content === "string"
    ? message.content
    : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("calendar tools", () => {
  let nudge: Nudge;
  let calendars: FakeCalendars;
  let requests: ModelContext[];

  beforeEach(async () => {
    process.env.TEST_CALDAV_PASSWORD = "pw";
    calendars = new FakeCalendars();
    requests = [];
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = (request: ModelContext) => {
      requests.push(request);
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult")
        return fauxAssistantMessage([
          fauxText(last.content.map((p) => (p.type === "text" ? p.text : "")).join("")),
        ]);
      const text = lastUser(request);
      if (/what's on/i.test(text))
        return fauxAssistantMessage(
          [fauxToolCall("calendar_events", { from: "2026-10-19", days: 7 })],
          { stopReason: "toolUse" },
        );
      if (/add the meeting/i.test(text))
        return fauxAssistantMessage(
          [
            fauxToolCall("calendar_add", {
              calendar: "skole",
              title: "Foreldremøte",
              start: "2026-10-22T18:00",
              location: "Aulaen",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (/drop football/i.test(text))
        return fauxAssistantMessage([fauxToolCall("calendar_remove", { id: "c0:football.ics" })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage([fauxText("Okay.")]);
    };
    faux.setResponses(Array.from({ length: 50 }, () => answer));
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        timeZone: OSLO,
        extensions: [
          {
            extension: calendarExtension({ backend: calendars }),
            settings: {
              accounts: [
                {
                  id: "family",
                  url: "https://dav.example/",
                  user: "fam",
                  password: "${TEST_CALDAV_PASSWORD}",
                  rooms: ["*"],
                },
              ],
            },
          },
        ],
      },
      context,
    );
  });

  afterEach(async () => {
    await nudge.close(context);
    delete process.env.TEST_CALDAV_PASSWORD;
  });

  const say = async (text: string) => {
    const settled = await (await nudge.submit(LOBBY, { text, author: by }, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
  };
  const toolOutput = () => {
    const last = requests.at(-1)!.messages.findLast((m) => m.role === "toolResult");
    return last?.role === "toolResult"
      ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      : "";
  };

  it("lists a week with ids, local times and repeats", async () => {
    await say("What's on next week?");
    expect(toolOutput().split("\n")).toEqual([
      "c0:autumn.ics  Mon 19 Oct – Fri 23 Oct, all day  Høstferie (Familie)",
      "c0:football.ics  Wed 21 Oct 18:00–19:30  Fotball (flyttet) @ Banen (Familie, repeats)",
    ]);
  });

  it("adds and removes events only once someone approves", async () => {
    await say("Add the meeting to the school calendar");
    expect(calendars.added).toEqual([]);
    let [approval] = await nudge.approvals.list(LOBBY, context);
    expect(approval!.summary).toBe(
      'Add "Foreldremøte" to the calendar Skole: Thu 22 Oct 18:00–19:00 at Aulaen',
    );
    await nudge.approvals.decide(LOBBY, approval!.id, { approve: true, by }, context);
    expect(calendars.added).toHaveLength(1);
    const added = calendars.added[0]!;
    expect(added.calendar).toBe("Skole");
    expect(added.filename).toMatch(/@nudge\.ics$/);
    expect(added.ics).toContain("DTSTART:20261022T160000Z");
    expect(added.ics).toContain("LOCATION:Aulaen");

    await nudge.harness.waitForIdle(context);
    await say("Drop football from the calendar");
    [approval] = await nudge.approvals.list(LOBBY, context);
    expect(approval!.summary).toBe(
      'Remove "Fotball" (Tue 3 Sept 17:30–19:00, and every repeat) from the calendar Familie',
    );
    await nudge.approvals.decide(LOBBY, approval!.id, { approve: true, by }, context);
    expect(calendars.removed).toEqual(["https://dav.example/cal/family/football.ics"]);
  });
});
