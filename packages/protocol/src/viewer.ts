import type {
  Approval,
  Fact,
  RoomListNudge,
  RoomListView,
  Player,
  QueuedMessage,
  RoomNudge,
  RoomView,
  TimelineItem,
} from "./schema.ts";

/**
 * Views as one player may see them. Hosts project a room once for everyone, then pass each
 * person's copy through their viewer before it leaves: what is private to someone else is emptied
 * or left out, and every string goes through `show`, which hides values others own and puts back
 * the ones this player may see. Unchanged parts come back as the same objects, so diffs stay cheap.
 */
export class Viewer {
  private memo = new WeakMap<object, unknown>();
  /** Apart from `memo`: an item's copy as shown and its copy as a stranger sees it differ. */
  private shown = new WeakMap<object, unknown>();
  private version: number;

  constructor(
    readonly playerId: string,
    /** Text as this player may see it, such as `Nudge.showTo`. */
    private readonly show: (text: string) => string,
    /** Goes up whenever `show` may give something new for the same text. */
    private readonly versionOf: () => number = () => 0,
  ) {
    this.version = versionOf();
  }

  room(view: RoomView): RoomView {
    this.check();
    return this.kept(view, () => ({
      room: this.texts(view.room),
      timeline: this.timeline(view.timeline),
      hasEarlier: view.hasEarlier,
      live: this.texts(view.live),
      queue: this.kept(view.queue, () => view.queue.map((item) => this.queued(item))),
      approvals: this.kept(view.approvals, () =>
        this.mine(view.approvals).map((a) => this.texts(a)),
      ),
      memory: this.kept(view.memory, () => this.mine(view.memory).map((fact) => this.texts(fact))),
      nudges: this.kept(view.nudges, () =>
        this.mine(view.nudges).map((nudge) => this.texts(nudge)),
      ),
    }));
  }

  roomList(view: RoomListView): RoomListView {
    this.check();
    return this.kept(view, () => ({
      player: view.player,
      rooms: view.rooms.map((row) => this.texts(row)),
      nudges: this.kept(view.nudges, () =>
        this.mine(view.nudges).map((nudge) => this.texts(nudge)),
      ),
      ...(view.appearance === undefined ? {} : { appearance: view.appearance }),
    }));
  }

  /** Timeline items, such as a page of history. */
  timeline(items: readonly TimelineItem[]): TimelineItem[] {
    this.check();
    return items.map((item) => this.item(item));
  }

  /** Any protocol value with its strings as the player may see them, such as a REST response. */
  strings<T>(value: T): T {
    this.check();
    return this.texts(value);
  }

  /** Whether the player may see something private to `owner`, or to nobody. */
  sees(owner: Player | undefined): boolean {
    return owner === undefined || owner.id === this.playerId;
  }

  private item(item: TimelineItem): TimelineItem {
    return this.kept(item, () => {
      if (item.type === "marker" || this.sees(item.privateTo)) return this.texts(item);
      switch (item.type) {
        case "user":
          return {
            type: "user",
            id: item.id,
            text: "",
            ...(item.author === undefined ? {} : { author: item.author }),
            ...(item.sentAt === undefined ? {} : { sentAt: item.sentAt }),
            privateTo: item.privateTo!,
          };
        case "nudge":
          return { ...item, text: "" };
        case "approval":
          return { ...item, summary: "" };
        case "answer":
          return {
            type: "answer",
            id: item.id,
            status: item.status,
            ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
            ...(item.promptedBy === undefined ? {} : { promptedBy: item.promptedBy }),
            parts: [],
            privateTo: item.privateTo!,
          };
      }
    });
  }

  private queued(item: QueuedMessage): QueuedMessage {
    return this.kept(item, () => {
      if (this.sees(item.privateTo)) return this.texts(item);
      return {
        id: item.id,
        mode: item.mode,
        text: "",
        ...(item.author === undefined ? {} : { author: item.author }),
        nudge: item.nudge,
        privateTo: item.privateTo!,
      };
    });
  }

  /** Only what is the player's or nobody's. */
  private mine<T extends Approval | Fact | RoomNudge | RoomListNudge>(list: readonly T[]): T[] {
    return list.filter((entry) => this.sees(entry.privateTo));
  }

  /** A copy with every string passed through `show`; keys and other values stay. */
  private texts<T>(value: T): T {
    if (typeof value === "string") return this.show(value) as T;
    if (value === null || typeof value !== "object") return value;
    return this.kept(
      value as object,
      () => {
        if (Array.isArray(value)) return value.map((entry) => this.texts(entry));
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, this.texts(entry)]),
        );
      },
      this.shown,
    ) as T;
  }

  private kept<T extends object, R>(source: T, build: () => R, memo = this.memo): R {
    const known = memo.get(source);
    if (known !== undefined) return known as R;
    const built = build();
    memo.set(source, built);
    return built;
  }

  /** Starts over once what `show` gives may have changed. */
  private check(): void {
    const version = this.versionOf();
    if (version === this.version) return;
    this.version = version;
    this.memo = new WeakMap();
    this.shown = new WeakMap();
  }
}
