import type { MonthUsage } from "@nudge/client";
import { dateLocale } from "./i18n/index.ts";

const USD = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

/** Dollars as the apps show them; a spend too small for a cent still shows there was one. */
export function dollars(value: number): string {
  return value > 0 && value < 0.005 ? `< ${USD.format(0.01)}` : USD.format(value);
}

/** "2026-10" as "October 2026", in the app's language. */
export function monthLabel(month: string): string {
  const [year, number] = month.split("-").map(Number);
  if (year === undefined || number === undefined || !Number.isInteger(year + number)) return month;
  return new Date(Date.UTC(year, number - 1, 1)).toLocaleDateString(dateLocale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export type SpendRow = { readonly id: string; readonly name: string; readonly usd: number };

/**
 * What a month's spend by player or room is, most first, with names from `names`; ones it doesn't
 * know (gone, or a room only an admin of it saw) keep their id.
 */
export function spendRows(
  spend: MonthUsage["players"] | MonthUsage["rooms"],
  names: ReadonlyMap<string, string>,
): SpendRow[] {
  return Object.entries(spend)
    .filter(([, usd]) => usd > 0)
    .map(([id, usd]) => ({ id, name: names.get(id) ?? id, usd }))
    .sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name));
}

/** How much of `limit` is spent, from 0 to 1, for a meter; undefined without a limit. */
export function shareOf(spent: number, limit: number | undefined): number | undefined {
  if (limit === undefined || limit <= 0) return undefined;
  return Math.min(1, Math.max(0, spent / limit));
}
