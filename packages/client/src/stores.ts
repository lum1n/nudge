import {
  apply,
  type HomeView,
  type RoomView,
  type ServerFrame,
  type TimelineItem,
  type TimelineResponse,
  type WhenBusy,
} from "@nudge/protocol";

/** The frames that belong to one target. */
export type TargetFrame = Extract<ServerFrame, { type: "snapshot" | "patch" | "unsubscribed" }>;

/** What a `Connection` hands a target's frames to. */
export interface Subscriber {
  /**
   * Takes the next frame for the target. False when it doesn't follow on from the last one (a gap
   * in `seq`, or ops that don't fit the view): the connection then subscribes again.
   */
  receive(frame: TargetFrame): boolean;
  /** The socket dropped, or the target is being subscribed again: wait for a new snapshot. */
  resync(): void;
}

export type ViewState<V> = {
  /** `syncing` until a snapshot arrives, and again after a drop or a gap; `gone` once unsubscribed. */
  readonly status: "syncing" | "live" | "gone";
  /** The latest view; kept, though possibly stale, while a new snapshot is on its way. */
  readonly view?: V;
  /** Why the server stopped sending the view: not a room of this player, or no longer. */
  readonly reason?: "not-found" | "removed";
};

/**
 * One target's view, kept up to date from its snapshot and patches. `subscribe` and `getState`
 * fit React's `useSyncExternalStore`; the state is a new object on every change, and parts of the
 * view that didn't change keep their identity.
 */
export class ViewStore<V> implements Subscriber {
  private seq: number | undefined;
  private current: ViewState<V> = { status: "syncing" };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): ViewState<V> => this.current;

  receive(frame: TargetFrame): boolean {
    switch (frame.type) {
      case "snapshot":
        this.seq = frame.seq;
        this.set({ status: "live", view: frame.view as V });
        return true;
      case "patch": {
        // Patches of a subscription replaced by one already asked for.
        if (this.seq === undefined) return true;
        const view = this.current.view;
        if (frame.seq !== this.seq + 1 || view === undefined) return this.lost();
        let next: V;
        try {
          next = apply(view, frame.ops);
        } catch {
          return this.lost();
        }
        this.seq = frame.seq;
        this.set({ status: "live", view: next });
        return true;
      }
      case "unsubscribed":
        this.seq = undefined;
        this.set({ status: "gone", reason: frame.reason, ...this.kept() });
        return true;
    }
  }

  resync(): void {
    this.seq = undefined;
    if (this.current.status === "live") this.set({ status: "syncing", ...this.kept() });
  }

  /** Called with every new state before listeners hear of it. */
  protected changed(_previous: ViewState<V>, _next: ViewState<V>): void {}

  protected notify(): void {
    for (const listener of this.listeners) listener();
  }

  private set(next: ViewState<V>): void {
    const previous = this.current;
    this.current = next;
    this.changed(previous, next);
    this.notify();
  }

  private lost(): false {
    this.resync();
    return false;
  }

  private kept(): { view?: V } {
    return this.current.view === undefined ? {} : { view: this.current.view };
  }
}

export class HomeStore extends ViewStore<HomeView> {}

/** A message this client sent that the room's view doesn't show yet. */
export type PendingMessage = {
  readonly requestId: string;
  readonly text: string;
  readonly whenBusy?: WhenBusy;
  /** Why sending it failed; send it again with the same `requestId`, or drop it. */
  readonly error?: string;
};

export type RoomState = ViewState<RoomView> & {
  /** `earlier`, then the view's timeline: everything to show, oldest first. */
  readonly timeline: readonly TimelineItem[];
  /** Items older than the view's: pages loaded, and items that slid out of the view's window. */
  readonly earlier: readonly TimelineItem[];
  readonly canLoadEarlier: boolean;
  readonly loadingEarlier: boolean;
  readonly earlierError?: string;
  /** Messages this client sent that are neither in the timeline nor queued yet, oldest first. */
  readonly pending: readonly PendingMessage[];
};

/** Fetches a page of the room's history, as `GET /rooms/<id>/timeline` does. */
export type PageLoader = (page: { before?: string; limit?: number }) => Promise<TimelineResponse>;

/**
 * A room's view, plus what the client keeps beside it: older items, from `/timeline` pages and from
 * the head of the view's window as it slides, and the messages it sent that the view doesn't show
 * yet. A user item or queued message with the same `requestId` replaces a pending one.
 */
export class RoomStore extends ViewStore<RoomView> {
  private earlier: TimelineItem[] = [];
  /** The next page's cursor; undefined for the page just before the view. */
  private before: string | undefined;
  private reachedStart = false;
  private loading = false;
  private earlierError: string | undefined;
  /** Bumped whenever `earlier` starts over, so a page fetched before then is dropped. */
  private generation = 0;
  private pending: PendingMessage[] = [];
  private room: RoomState = { status: "syncing", ...EMPTY };
  private joined: { earlier?: TimelineItem[]; view?: TimelineItem[]; all: TimelineItem[] } = {
    all: [],
  };

  constructor(
    readonly id: string,
    private readonly pages?: PageLoader,
  ) {
    super();
  }

  override readonly getState = (): RoomState => this.room;

  /** Shows `message` as pending until the view has it. */
  sending(message: PendingMessage): void {
    this.pending = [...this.pending.filter((p) => p.requestId !== message.requestId), message];
    this.publish();
  }

  failed(requestId: string, error: string): void {
    this.pending = this.pending.map((p) => (p.requestId === requestId ? { ...p, error } : p));
    this.publish();
  }

  /** Stops showing a pending message, such as one that failed and won't be sent again. */
  dismiss(requestId: string): void {
    this.pending = this.pending.filter((p) => p.requestId !== requestId);
    this.publish();
  }

  /** Fetches the page before `earlier`; does nothing while one is loading or at the start. */
  async loadEarlier(limit?: number): Promise<void> {
    if (this.loading || !this.canLoadEarlier()) return;
    const generation = this.generation;
    this.loading = true;
    this.earlierError = undefined;
    this.publish();
    try {
      const page = await this.pages!({
        ...(this.before === undefined ? {} : { before: this.before }),
        ...(limit === undefined ? {} : { limit }),
      });
      if (generation !== this.generation) return;
      // A page fetched without a cursor ends at the view's window, so it may hold slid items.
      const known = new Set(
        [...this.earlier, ...(this.room.view?.timeline ?? [])].map((item) => item.id),
      );
      this.earlier = [...page.items.filter((item) => !known.has(item.id)), ...this.earlier];
      this.before = page.before;
      this.reachedStart = page.before === undefined;
    } catch (error) {
      if (generation === this.generation) this.earlierError = (error as Error).message;
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.publish();
      }
    }
  }

  protected override changed(previous: ViewState<RoomView>, next: ViewState<RoomView>): void {
    const before = previous.view?.timeline;
    const after = next.view?.timeline;
    if (before !== undefined && after !== undefined && before !== after) {
      const earlier = slide(this.earlier, before, after);
      if (earlier === undefined) this.startOver();
      else this.earlier = earlier;
    }
    if (next.view !== previous.view) this.pending = unseen(this.pending, next.view);
    this.room = this.build(next);
  }

  private startOver(): void {
    this.earlier = [];
    this.before = undefined;
    this.reachedStart = false;
    this.loading = false;
    this.earlierError = undefined;
    this.generation += 1;
  }

  private canLoadEarlier(view = this.room.view): boolean {
    return this.pages !== undefined && !this.reachedStart && view?.hasEarlier === true;
  }

  private publish(): void {
    this.room = this.build(this.room);
    this.notify();
  }

  private build(state: ViewState<RoomView>): RoomState {
    const { status, view, reason } = state;
    return {
      status,
      ...(view === undefined ? {} : { view }),
      ...(reason === undefined ? {} : { reason }),
      timeline: this.timeline(view?.timeline),
      earlier: this.earlier,
      canLoadEarlier: this.canLoadEarlier(view),
      loadingEarlier: this.loading,
      ...(this.earlierError === undefined ? {} : { earlierError: this.earlierError }),
      pending: this.pending,
    };
  }

  /** `earlier` and the view's timeline, joined; the same array while neither changed. */
  private timeline(view: TimelineItem[] | undefined): TimelineItem[] {
    const joined = this.joined;
    if (joined.earlier !== this.earlier || joined.view !== view)
      this.joined = {
        earlier: this.earlier,
        view,
        all: this.earlier.length === 0 ? (view ?? []) : [...this.earlier, ...(view ?? [])],
      };
    return this.joined.all;
  }
}

const EMPTY = {
  timeline: [],
  earlier: [],
  canLoadEarlier: false,
  loadingEarlier: false,
  pending: [],
} as const;

/**
 * `earlier` after the view's window moved from `before` to `after`: items that left its head are
 * added, newest last. Undefined when the windows don't overlap, so items between them may be
 * missing (after a long time offline, say): `earlier` then starts over.
 */
export function slide(
  earlier: TimelineItem[],
  before: readonly TimelineItem[],
  after: readonly TimelineItem[],
): TimelineItem[] | undefined {
  const head = after[0];
  if (before.length === 0 || head === undefined) return earlier;
  const inAfter = new Set(after.map((item) => item.id));
  let left: readonly TimelineItem[];
  if (inAfter.has(before[0]!.id)) left = [];
  else {
    const start = before.findIndex((item) => item.id === head.id);
    if (start === -1) return undefined;
    left = before.slice(0, start);
  }
  if (left.length === 0 && !earlier.some((item) => inAfter.has(item.id))) return earlier;
  const known = new Set(earlier.map((item) => item.id));
  return [...earlier, ...left.filter((item) => !known.has(item.id))].filter(
    (item) => !inAfter.has(item.id),
  );
}

/** The pending messages that `view` doesn't show yet, in its timeline or its queue. */
function unseen(pending: PendingMessage[], view: RoomView | undefined): PendingMessage[] {
  if (pending.length === 0 || view === undefined) return pending;
  const seen = new Set<string>();
  for (const item of view.timeline)
    if (item.type === "user" && item.requestId !== undefined) seen.add(item.requestId);
  for (const queued of view.queue) if (queued.requestId !== undefined) seen.add(queued.requestId);
  const left = pending.filter((message) => !seen.has(message.requestId));
  return left.length === pending.length ? pending : left;
}
