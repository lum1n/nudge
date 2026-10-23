import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type CommitPublication,
  type ConversationId,
  type Cursor,
  defineDoc,
  type Harness,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import { MESSAGE_ENTRY, type MessageEntryData } from "./host-api.ts";
import type { DirectoryState } from "./identity/directory.ts";

/** Monthly limits on model spend, in US dollars as the model catalog prices it. */
export type Budget = {
  /** For the whole assistant: past it, no model request goes out until the month ends. */
  readonly monthlyUsd?: number;
  /** For each player: past it, their messages are refused until the month ends. */
  readonly perPlayerUsd?: number;
  /** Share of a limit at which a warning goes out once a month; default 0.8. */
  readonly warnAt?: number;
  /**
   * Without `monthlyUsd`: the spend at which the admins are told, once a month, that there is no
   * limit. Nothing is refused. Default `DEFAULT_WARN_USD`.
   */
  readonly warnUsd?: number;
};

/** What an assistant with no monthly budget may spend in a month before its admins hear of it. */
export const DEFAULT_WARN_USD = 25;

// Stored in a document, so plain JSON.
export type MonthSpend = {
  total: number;
  /** By room id; side conversations count for their room. */
  rooms: Record<string, number>;
  /** By the player whose message was being answered; nudges and watches count for nobody. */
  players: Record<string, number>;
  /** Warnings sent this month: `assistant` and `player:<id>`. */
  warned: string[];
};

export type SpendState = {
  /** By `YYYY-MM` in the assistant's time zone; the last twelve are kept. */
  months: Record<string, MonthSpend>;
};

export const SpendDoc = defineDoc<SpendState>({
  kind: "nudge.spend",
  version: 1,
  scope: "session",
  initial: () => ({ months: {} }),
});

const KEEP_MONTHS = 12;

/** Who to tell that a limit is near: the player, or the assistant's admins. */
export type SpendWarning = {
  readonly kind: "assistant" | "player";
  readonly playerId?: string;
  readonly spent: number;
  readonly limit: number;
  /** No budget is set, and nothing is refused: `limit` is only where the warning goes out. */
  readonly unlimited?: true;
};

export class BudgetReached extends Error {
  override name = "BudgetReached";
}

/**
 * Books every conversation's model spend as Pi Durable records it (`pi.usage`, the assistant's
 * own requests and what tools report) to the month, the room and the player being answered, and
 * says when a budget is spent. Only increases are booked, from the totals seen at open on.
 */
export class Spending {
  /** Per conversation: its total cost as last seen. */
  private readonly seen = new Map<number, number>();
  /** Per conversation: the player whose message is being answered, if any. */
  private readonly answering = new Map<number, string | undefined>();
  private rooms = new Map<number, string>();
  private state: SpendState;
  private queue: { month: string; usd: number; roomId?: string; playerId?: string }[] = [];
  private writing: Promise<void> = Promise.resolve();
  private readonly stop: () => void;

  private constructor(
    private readonly harness: Harness,
    private readonly budget: Budget,
    private readonly timeZone: string,
    private readonly now: () => number,
    private readonly warn: (warning: SpendWarning) => void,
    private readonly report: (error: unknown) => void,
    state: SpendState | undefined,
    directory: DirectoryState | undefined,
    totals: ReadonlyMap<number, number>,
  ) {
    this.state = structuredClone(state ?? { months: {} });
    this.index(directory);
    for (const [id, total] of totals) this.seen.set(id, total);
    this.stop = harness.subscribeCommits((publication) => this.take(publication));
  }

  static async open(
    harness: Harness,
    options: {
      readonly budget: Budget;
      readonly timeZone: string;
      readonly now: () => number;
      readonly warn: (warning: SpendWarning) => void;
      readonly report: (error: unknown) => void;
    },
    directory: DirectoryState | undefined,
    context: Context,
  ): Promise<Spending> {
    const totals = new Map<number, number>();
    for (const id of await conversationIds(harness, context)) {
      const usage = await harness.snapshot(UsageDoc, id as ConversationId, context);
      if (usage !== undefined) totals.set(id, totalCost(usage));
    }
    return new Spending(
      harness,
      options.budget,
      options.timeZone,
      options.now,
      options.warn,
      options.report,
      await harness.snapshot(SpendDoc, context),
      directory,
      totals,
    );
  }

  /** This month's spend, and the limits. */
  thisMonth(): { readonly month: string; readonly spend: MonthSpend; readonly budget: Budget } {
    const month = this.monthOf(this.now());
    return { month, spend: this.monthSpend(month), budget: this.budget };
  }

  /** Every month kept, newest first. */
  months(): { readonly month: string; readonly spend: MonthSpend }[] {
    return Object.entries(this.state.months)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([month, spend]) => ({ month, spend: structuredClone(spend) }));
  }

  /** Why no model request may go out now, or undefined. */
  refusal(): string | undefined {
    const { monthlyUsd } = this.budget;
    if (monthlyUsd === undefined) return undefined;
    const { spend } = this.thisMonth();
    if (spend.total < monthlyUsd) return undefined;
    return `This assistant has used its budget for the month (${usd(spend.total)} of ${usd(monthlyUsd)}).`;
  }

  /** Why `playerId` may not send a message now, or undefined. */
  refusalFor(playerId: string): string | undefined {
    const assistant = this.refusal();
    if (assistant !== undefined) return assistant;
    const { perPlayerUsd } = this.budget;
    if (perPlayerUsd === undefined) return undefined;
    const spent = this.thisMonth().spend.players[playerId] ?? 0;
    if (spent < perPlayerUsd) return undefined;
    return `You have used your budget for the month (${usd(spent)} of ${usd(perPlayerUsd)}).`;
  }

  /** Waits until what was booked so far is stored. */
  async flush(): Promise<void> {
    await this.writing;
  }

  close(): void {
    this.stop();
  }

  private take(publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (change.type === "document" && change.record.kind === "nudge.directory" && change.value)
        this.index(change.value as unknown as DirectoryState);
      if (change.type === "entry") {
        const { kind, conversationId, data } = change.value;
        if (kind === MESSAGE_ENTRY)
          this.answering.set(conversationId, (data as MessageEntryData | undefined)?.playerId);
        else if (kind === "nudge.fire" || kind === "nudge.approval" || kind === "pi.user")
          this.answering.set(conversationId, undefined);
      }
    }
    for (const change of publication.changes) {
      if (change.type !== "document" || change.record.kind !== "pi.usage") continue;
      const id = change.conversationId;
      if (id === undefined || change.value === null) continue;
      const total = totalCost(change.value as unknown as UsageState);
      const delta = total - (this.seen.get(id) ?? 0);
      this.seen.set(id, total);
      if (!(delta > 0)) continue;
      const roomId = this.rooms.get(id);
      const playerId = this.answering.get(id);
      this.queue.push({
        month: this.monthOf(this.now()),
        usd: delta,
        ...(roomId === undefined ? {} : { roomId }),
        ...(playerId === undefined ? {} : { playerId }),
      });
    }
    if (this.queue.length > 0) this.schedule();
  }

  /** Writes queued spend in a commit of its own, after the one that recorded it. */
  private schedule(): void {
    this.writing = this.writing
      .then(async () => {
        const batch = this.queue;
        this.queue = [];
        if (batch.length === 0) return;
        const state = await this.harness.commit(async (tx) => {
          const doc = await tx.doc(SpendDoc);
          for (const { month, usd, roomId, playerId } of batch) {
            doc.months[month] ??= { total: 0, rooms: {}, players: {}, warned: [] };
            const spend = doc.months[month];
            spend.total += usd;
            if (roomId !== undefined) spend.rooms[roomId] = (spend.rooms[roomId] ?? 0) + usd;
            if (playerId !== undefined)
              spend.players[playerId] = (spend.players[playerId] ?? 0) + usd;
          }
          const warnings = this.warnings(doc.months[this.monthOf(this.now())]);
          for (const warning of warnings)
            doc.months[this.monthOf(this.now())]!.warned.push(warningKey(warning));
          for (const old of Object.keys(doc.months).sort().slice(0, -KEEP_MONTHS))
            delete doc.months[old];
          // A copy, not the draft: the draft is only good inside the commit.
          return { state: JSON.parse(JSON.stringify(doc)) as SpendState, warnings };
        }, BACKGROUND_CONTEXT);
        this.state = state.state;
        for (const warning of state.warnings) {
          try {
            this.warn(warning);
          } catch (error) {
            this.report(error);
          }
        }
      })
      .catch(this.report);
  }

  private warnings(spend: MonthSpend | undefined): SpendWarning[] {
    if (spend === undefined) return [];
    const share = this.budget.warnAt ?? 0.8;
    const found: SpendWarning[] = [];
    const { monthlyUsd, perPlayerUsd } = this.budget;
    if (monthlyUsd !== undefined && spend.total >= monthlyUsd * share)
      found.push({ kind: "assistant", spent: spend.total, limit: monthlyUsd });
    const warnUsd = this.budget.warnUsd ?? DEFAULT_WARN_USD;
    if (monthlyUsd === undefined && spend.total >= warnUsd)
      found.push({ kind: "assistant", spent: spend.total, limit: warnUsd, unlimited: true });
    if (perPlayerUsd !== undefined)
      for (const [playerId, spent] of Object.entries(spend.players))
        if (spent >= perPlayerUsd * share)
          found.push({ kind: "player", playerId, spent, limit: perPlayerUsd });
    return found.filter((warning) => !spend.warned.includes(warningKey(warning)));
  }

  private monthSpend(month: string): MonthSpend {
    return structuredClone(
      this.state.months[month] ?? { total: 0, rooms: {}, players: {}, warned: [] },
    );
  }

  private monthOf(at: number): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timeZone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(at);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}`;
  }

  private index(directory: DirectoryState | undefined): void {
    this.rooms = new Map([
      ...Object.values(directory?.rooms ?? {}).map(
        (room) => [room.conversationId, room.id] as const,
      ),
      ...Object.entries(directory?.sides ?? {}).map(
        ([id, side]) => [Number(id), side.roomId] as const,
      ),
    ]);
  }
}

function warningKey(warning: SpendWarning): string {
  return warning.kind === "assistant" ? "assistant" : `player:${warning.playerId}`;
}

/** A usage ledger's total cost: every model and tool bucket. */
export function totalCost(usage: Readonly<UsageState>): number {
  let total = 0;
  for (const bucket of [usage.models, usage.tools])
    for (const entry of Object.values(bucket ?? {}))
      total += (entry as { cost?: { total?: number } }).cost?.total ?? 0;
  return total;
}

export function usd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 3 : 2)}`;
}

/** Every conversation's id, whoever owns it. */
async function conversationIds(harness: Harness, context: Context): Promise<number[]> {
  const ids: number[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 500, cursor), context);
    ids.push(...page.items.map((conversation) => conversation.id));
    cursor = page.next;
  } while (cursor !== undefined);
  return ids;
}
