// What the eval runner checks and prints, apart from running browsers: kept free of I/O so the
// tests can check it without keys.

/** A personal value from a task found in a request the provider got. */
export interface Leak {
  value: string;
  /** Index of the request in the dump. */
  request: number;
}

/**
 * Personal values from a task's text that reached a request as they are, ignoring case, and for
 * values with digits also with their spaces, dots and dashes taken out (`912 34 567` as `91234567`).
 */
export function findLeaks(requests: readonly string[], values: readonly string[]): Leak[] {
  const leaks: Leak[] = [];
  const squeeze = (text: string) => text.replace(/[\s.\-–]+/g, "");
  requests.forEach((request, index) => {
    // JSON escapes some characters; compare against the text the model reads.
    const plain = request.replace(/\\n/g, "\n").replace(/\\"/g, '"').toLowerCase();
    const squeezed = squeeze(plain);
    for (const value of values) {
      const lower = value.toLowerCase();
      const found =
        plain.includes(lower) || (/\d/.test(value) && squeezed.includes(squeeze(lower)));
      if (found) leaks.push({ value, request: index });
    }
  });
  return leaks;
}

/** One run of one task on one model, as the runner records it. */
export interface RunRecord {
  task: string;
  model: string;
  outcome: string;
  expectMatched?: boolean;
  steps: number;
  seconds: number;
  cost: number;
  leaks: number;
}

/** A Markdown table with a row per model and task: how its runs went, side by side. */
export function summaryTable(records: readonly RunRecord[]): string {
  const groups = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = `${record.model}\u0000${record.task}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const rows = [...groups.values()].map((runs) => {
    const answered = runs.filter((r) => r.outcome === "answered").length;
    const checked = runs.filter((r) => r.expectMatched !== undefined);
    const matched = checked.filter((r) => r.expectMatched).length;
    const leaks = runs.reduce((sum, r) => sum + r.leaks, 0);
    const others = [...new Set(runs.map((r) => r.outcome).filter((o) => o !== "answered"))];
    return [
      runs[0]!.model,
      runs[0]!.task,
      `${answered}/${runs.length}${others.length ? ` (${others.join(", ")})` : ""}`,
      checked.length ? `${matched}/${checked.length}` : "–",
      String(median(runs.map((r) => r.steps))),
      String(median(runs.map((r) => r.seconds))),
      `$${(runs.reduce((sum, r) => sum + r.cost, 0) / runs.length).toFixed(3)}`,
      leaks === 0 ? "none" : `**${leaks}**`,
    ];
  });
  const head = ["model", "task", "answered", "expected", "steps", "seconds", "cost/run", "leaks"];
  return [head, head.map(() => "---"), ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
