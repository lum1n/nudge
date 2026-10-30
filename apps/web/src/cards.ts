import type { UiCard } from "@nudge/client";

/** The card a tool part's details hold (ADR 27); the server leaves out one that isn't valid. */
export function cardIn(details: unknown): UiCard | undefined {
  const ui = (details as { ui?: Partial<UiCard> } | undefined)?.ui;
  return typeof ui === "object" && ui !== null && ui.v === 1 ? (ui as UiCard) : undefined;
}
