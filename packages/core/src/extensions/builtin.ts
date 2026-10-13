import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

export type BuiltinOptions = {
  readonly displayName: string;
  readonly timeZone: string;
  readonly now: () => number;
};

/** The always-on `nudge` extension: who the assistant is and what time it is. */
export function createBuiltinExtension(options: BuiltinOptions): Extension {
  return defineExtension({
    name: "nudge",
    sections: [
      section(
        "identity",
        () =>
          `You are ${options.displayName}, a personal assistant. Be brief and concrete. ` +
          `Several people may share a conversation; each message starts with the name of who wrote it.`,
        { tag: false },
      ),
      // Rendered to the hour: a section that changes on every request defeats prompt caching.
      section("time", () => formatHour(options.now(), options.timeZone)),
    ],
  });
}

export function formatHour(now: number, timeZone: string): string {
  const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000);
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(hour);
  return `It is ${text} (${timeZone}), give or take an hour.`;
}
