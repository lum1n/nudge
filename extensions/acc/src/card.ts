import { type UiCard, UI_CARD_MAX_CHARS } from "@nudge/core";

/** A coding session as `acc_sessions` lists it. */
export type SessionRow = {
  host: string;
  id: string;
  harness: string;
  /** `running`, `exited` or `gone`. */
  status: "running" | "exited" | "gone";
  /** Minutes since it was last active, when known. */
  idleMinutes?: number;
  /** What a followed session does now. */
  doing?: string;
  title?: string;
};

const MAX_STEPS = 20;

const cut = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

function ago(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return minutes < 2880
    ? `${Math.round(minutes / 60)} h ago`
    : `${Math.round(minutes / 1440)} d ago`;
}

/**
 * The sessions as a timeline, newest first, with how many run now. Undefined when there are none,
 * or the card would be too big to show. `rows` are in the order to show.
 */
export function sessionsCard(rows: readonly SessionRow[]): UiCard | undefined {
  if (rows.length === 0) return undefined;
  const shown = rows.slice(0, MAX_STEPS);
  const running = rows.filter((row) => row.status === "running").length;
  const card: UiCard = {
    v: 1,
    title: "Coding sessions",
    blocks: [
      {
        type: "stats",
        items: [
          { label: "Running", value: String(running) },
          { label: "Sessions", value: String(rows.length) },
        ],
      },
      {
        type: "timeline",
        items: shown.map((row) => ({
          title: cut(row.title ?? `${row.harness} ${row.id}`, 80),
          ...(row.idleMinutes === undefined ? {} : { time: ago(row.idleMinutes) }),
          subtitle: cut(
            [`${row.host}/${row.id}`, row.status, row.doing].filter(Boolean).join(" · "),
            120,
          ),
          state: row.status === "running" ? ("current" as const) : ("done" as const),
        })),
      },
    ],
  };
  return JSON.stringify(card).length > UI_CARD_MAX_CHARS ? undefined : card;
}
