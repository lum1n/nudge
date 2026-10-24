import type { AssistantBudget } from "@nudge/client";

/** An assistant's budget as the settings page edits it: what is typed in each field. */
export type BudgetDraft = {
  /** US dollars a month for everyone together; empty for no limit. */
  readonly monthlyUsd: string;
  /** US dollars a month for each person; empty for no limit. */
  readonly perPlayerUsd: string;
  /** Percent of a limit at which admins hear of it; empty for the default, 80. */
  readonly warnAtPercent: string;
  /** Without a monthly limit, US dollars a month at which admins hear of it; empty for 25. */
  readonly warnUsd: string;
};

/** The default an empty field stands for, as the server has it (`spending.ts`). */
export const BUDGET_DEFAULTS = { warnAtPercent: 80, warnUsd: 25 } as const;

export function budgetDraftOf(budget: AssistantBudget | undefined): BudgetDraft {
  const text = (value: number | undefined) => (value === undefined ? "" : String(value));
  return {
    monthlyUsd: text(budget?.monthlyUsd),
    perPlayerUsd: text(budget?.perPlayerUsd),
    // Rounded, so 0.7 shows as 70 rather than 70.00000000000001.
    warnAtPercent: text(
      budget?.warnAt === undefined ? undefined : Math.round(budget.warnAt * 10_000) / 100,
    ),
    warnUsd: text(budget?.warnUsd),
  };
}

/**
 * The budget to send for `draft`: the PATCH replaces the budget whole, so every field goes with
 * it, `warnUsd` included. `null` when every field is empty, which puts the defaults back. A field
 * that isn't a number in range gives the error to show instead.
 */
export function budgetOf(
  draft: BudgetDraft,
): { readonly budget: AssistantBudget | null } | { readonly error: string } {
  const budget: {
    monthlyUsd?: number;
    perPlayerUsd?: number;
    warnAt?: number;
    warnUsd?: number;
  } = {};
  const fields = [
    ["monthlyUsd", draft.monthlyUsd, "The monthly limit"],
    ["perPlayerUsd", draft.perPlayerUsd, "The limit per person"],
    ["warnUsd", draft.warnUsd, "The amount to hear of spend at"],
  ] as const;
  for (const [key, typed, label] of fields) {
    if (typed.trim() === "") continue;
    const value = Number(typed.trim());
    if (!Number.isFinite(value) || value <= 0)
      return { error: `${label} must be a number of dollars above 0` };
    budget[key] = value;
  }
  if (draft.warnAtPercent.trim() !== "") {
    const percent = Number(draft.warnAtPercent.trim());
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100)
      return { error: "Warn at must be a percent from above 0 to 100" };
    budget.warnAt = percent / 100;
  }
  return { budget: Object.keys(budget).length === 0 ? null : budget };
}
