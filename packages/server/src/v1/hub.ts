import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationView,
  ConversationWatch,
  DocumentWatch,
} from "@earendil-works/pi-durable";
import {
  type Approval,
  type Change,
  canUse,
  DirectoryDoc,
  type DirectoryState,
  type Fact,
  type Nudge,
  type Room as CoreRoom,
  type ScheduledNudge,
} from "@nudge/core";
import type { HomeRoom, HomeView, Player, Room, RoomView } from "@nudge/protocol";
import { projectHome, RoomProjector, toPlayer, toRoom } from "@nudge/protocol/project";

const context: Context = BACKGROUND_CONTEXT;

/** Something a connection watches: its view now, and a call whenever that may have changed. */
export interface Hub<V> {
  view(): V;
  /** `changed` after every change; `ended` once, when the hub stops for good. */
  listen(listener: HubListener): () => void;
}

export type HubListener = {
  readonly changed: () => void;
  /** `gone`: the room no longer exists. `closed`: the assistant shut down. */
  readonly ended: (reason: "gone" | "closed") => void;
};

/** A hub held by one subscription; `release` lets it close once nobody holds it. */
export type Lease<H> = { readonly hub: H; release(): void };

/**
 * The live views of one assistant, shared by every connection: one `RoomHub` per room someone
 * watches, one `HomeHub` per player. Hubs open on first use and close when their last lease goes.
 */
export class Hubs {
  private readonly rooms = new Shared<RoomHub>();
  private readonly homes = new Shared<HomeHub>();
  private directory: Promise<Directory> | undefined;

  constructor(
    readonly nudge: Nudge,
    private readonly report: (error: unknown) => void,
  ) {}

  /** `undefined` when the room does not exist. Whether the player may use it is the caller's check. */
  async room(roomId: string): Promise<Lease<RoomHub> | undefined> {
    if ((await this.nudge.rooms.get(roomId, context)) === undefined) return undefined;
    const directory = await this.openDirectory();
    return this.rooms.lease(roomId, () => RoomHub.open(this.nudge, roomId, directory, this.report));
  }

  async home(playerId: string): Promise<Lease<HomeHub>> {
    const directory = await this.openDirectory();
    return this.homes.lease(playerId, () =>
      Promise.resolve(new HomeHub(playerId, directory, this, this.report)),
    );
  }

  private openDirectory(): Promise<Directory> {
    this.directory ??= Directory.open(this.nudge).catch((error: unknown) => {
      this.directory = undefined;
      throw error;
    });
    return this.directory;
  }
}

/** Hubs by key, opened once and closed when the last lease is released. */
class Shared<H extends { close(): void }> {
  private readonly entries = new Map<string, { hub: Promise<H>; leases: number }>();

  async lease(key: string, open: () => Promise<H>): Promise<Lease<H>> {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { hub: open(), leases: 0 };
      this.entries.set(key, entry);
      const opening = entry;
      opening.hub.catch(() => {
        if (this.entries.get(key) === opening) this.entries.delete(key);
      });
    }
    entry.leases++;
    const held = entry;
    let hub: H;
    try {
      hub = await held.hub;
    } catch (error) {
      held.leases--;
      throw error;
    }
    let released = false;
    return {
      hub,
      release: () => {
        if (released) return;
        released = true;
        if (--held.leases > 0) return;
        if (this.entries.get(key) === held) this.entries.delete(key);
        hub.close();
      },
    };
  }
}

/** The directory document, kept current for every hub of the assistant. */
class Directory {
  private readonly listeners = new Set<() => void>();

  private constructor(private watch: DocumentWatch<DirectoryState> | undefined) {}

  static async open(nudge: Nudge): Promise<Directory> {
    const watch = await nudge.harness.watchDoc(DirectoryDoc, context);
    const directory = new Directory(watch);
    watch?.start(async () => {
      for (const listener of directory.listeners) listener();
    });
    return directory;
  }

  get value(): Readonly<DirectoryState> {
    return this.watch?.value ?? { players: {}, tokens: {}, rooms: {} };
  }

  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class Listeners {
  private readonly all = new Set<HubListener>();
  private end: "gone" | "closed" | undefined;

  add(listener: HubListener): () => void {
    if (this.end !== undefined) {
      const end = this.end;
      queueMicrotask(() => listener.ended(end));
      return () => {};
    }
    this.all.add(listener);
    return () => this.all.delete(listener);
  }

  changed(): void {
    for (const listener of this.all) listener.changed();
  }

  ended(reason: "gone" | "closed"): void {
    if (this.end !== undefined) return;
    this.end = reason;
    for (const listener of this.all) listener.ended(reason);
    this.all.clear();
  }
}

/**
 * One room's `RoomView`: the conversation watch, plus memory, approvals and nudges read again
 * after a commit that added or changed entries (tools change them inside a turn) and when
 * `Nudge.changes` names the room.
 */
export class RoomHub implements Hub<RoomView> {
  private readonly listeners = new Listeners();
  private readonly projector = new RoomProjector();
  private projected: RoomView | undefined;
  private room: Room;
  private stopped = false;
  /** Re-reads run one at a time, in order. */
  private reading: Promise<void> = Promise.resolve();
  private readonly unsubscribe: (() => void)[] = [];

  private constructor(
    private readonly nudge: Nudge,
    readonly roomId: string,
    private core: CoreRoom,
    private readonly directory: Directory,
    private readonly watch: ConversationWatch,
    private conversation: ConversationView,
    private approvals: readonly Approval[],
    private memory: readonly Fact[],
    private nudges: readonly ScheduledNudge[],
    private readonly report: (error: unknown) => void,
  ) {
    this.room = this.projectRoom();
  }

  static async open(
    nudge: Nudge,
    roomId: string,
    directory: Directory,
    report: (error: unknown) => void,
  ): Promise<RoomHub> {
    const core = directory.value.rooms[roomId] ?? (await nudge.rooms.get(roomId, context));
    if (core === undefined) throw new Error(`No room "${roomId}"`);
    const watch = await nudge.watchRoom(roomId, context);
    try {
      const [approvals, memory, nudges] = await Promise.all([
        nudge.approvals.list(roomId, context),
        nudge.memory.list(roomId, context),
        nudge.nudges.list(context, [roomId]),
      ]);
      const hub = new RoomHub(
        nudge,
        roomId,
        core,
        directory,
        watch,
        watch.value,
        approvals,
        memory,
        nudges,
        report,
      );
      hub.start();
      return hub;
    } catch (error) {
      await watch.stop();
      throw error;
    }
  }

  /** Whether `playerId` may use the room as it is now. */
  allows(playerId: string): boolean {
    return canUse(this.core, playerId);
  }

  view(): RoomView {
    this.projected ??= this.projector.project({
      room: this.room,
      view: this.conversation,
      approvals: this.approvals,
      memory: this.memory,
      nudges: this.nudges,
    });
    return this.projected;
  }

  /** The room's pending nudges as last read. */
  nudgesNow(): readonly ScheduledNudge[] {
    return this.nudges;
  }

  listen(listener: HubListener): () => void {
    return this.listeners.add(listener);
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    void this.watch.stop();
  }

  private start(): void {
    this.watch.start(async (value) => {
      const entriesChanged = value.entries !== this.conversation.entries;
      this.conversation = value;
      this.update();
      if (entriesChanged) this.read(["approvals", "memory", "nudges"]);
    });
    void this.watch.closed.then(() => {
      if (!this.stopped) this.end("closed");
    });
    this.unsubscribe.push(
      this.nudge.changes.subscribe((change: Change) => {
        if (change.kind !== "rooms" && change.roomId === this.roomId) this.read([change.kind]);
      }),
      this.directory.listen(() => {
        const core = this.directory.value.rooms[this.roomId];
        if (core === undefined) return this.end("gone");
        this.core = core;
        const room = this.projectRoom(core);
        if (JSON.stringify(room) === JSON.stringify(this.room)) return;
        this.room = room;
        this.update();
      }),
    );
    // Whatever changed between the first reads and the subscriptions above.
    this.read(["approvals", "memory", "nudges"]);
  }

  private read(kinds: readonly ("approvals" | "memory" | "nudges")[]): void {
    this.reading = this.reading
      .then(async () => {
        if (this.stopped) return;
        const [approvals, memory, nudges] = await Promise.all([
          kinds.includes("approvals") ? this.nudge.approvals.list(this.roomId, context) : undefined,
          kinds.includes("memory") ? this.nudge.memory.list(this.roomId, context) : undefined,
          kinds.includes("nudges") ? this.nudge.nudges.list(context, [this.roomId]) : undefined,
        ]);
        if (this.stopped) return;
        if (approvals !== undefined) this.approvals = approvals;
        if (memory !== undefined) this.memory = memory;
        if (nudges !== undefined) this.nudges = nudges;
        this.update();
      })
      .catch((error: unknown) => {
        if (!this.stopped) this.report(error);
      });
  }

  private update(): void {
    if (this.stopped) return;
    this.projected = undefined;
    this.listeners.changed();
  }

  private end(reason: "gone" | "closed"): void {
    this.close();
    this.listeners.ended(reason);
  }

  private projectRoom(core = this.core): Room {
    const players = this.directory.value.players;
    return toRoom(core, (id) => players[id]);
  }
}

/**
 * One player's `HomeView`: the rooms they may use, each through its `RoomHub`, so home and room
 * subscriptions share one watch per room. The player's nudges are their rooms' nudges.
 */
export class HomeHub implements Hub<HomeView> {
  private readonly listeners = new Listeners();
  private readonly leases = new Map<string, Lease<RoomHub> | Promise<void>>();
  private readonly unlisten = new Map<string, () => void>();
  private readonly rows = new Map<string, { view: RoomView; row: HomeRoom }>();
  private projected: HomeView | undefined;
  private player: Player;
  private stopped = false;
  private readonly stopDirectory: () => void;

  constructor(
    private readonly playerId: string,
    private readonly directory: Directory,
    private readonly hubs: Hubs,
    private readonly report: (error: unknown) => void,
  ) {
    this.player = this.projectPlayer();
    this.stopDirectory = directory.listen(() => this.sync());
    this.sync();
  }

  view(): HomeView {
    if (this.projected !== undefined) return this.projected;
    const rooms: HomeRoom[] = [];
    const nudges: ScheduledNudge[] = [];
    for (const room of this.usableRooms()) {
      const lease = this.leases.get(room.id);
      if (lease === undefined || lease instanceof Promise) continue;
      rooms.push(this.row(lease.hub));
      nudges.push(...lease.hub.nudgesNow());
    }
    this.projected = projectHome({ player: this.player, rooms, nudges });
    return this.projected;
  }

  /** Settles once every room the player may use now has its hub, so the first view lists them all. */
  async ready(): Promise<void> {
    await Promise.all([...this.leases.values()].filter((lease) => lease instanceof Promise));
  }

  listen(listener: HubListener): () => void {
    return this.listeners.add(listener);
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopDirectory();
    for (const id of this.leases.keys()) this.drop(id);
  }

  /** Opens hubs for rooms the player gained and releases those of rooms they lost. */
  private sync(): void {
    if (this.stopped) return;
    const player = this.projectPlayer();
    if (JSON.stringify(player) !== JSON.stringify(this.player)) this.player = player;
    const usable = new Set(this.usableRooms().map((room) => room.id));
    for (const id of this.leases.keys()) if (!usable.has(id)) this.drop(id);
    for (const id of usable) if (!this.leases.has(id)) this.add(id);
    this.update();
  }

  private add(id: string): void {
    const opening = this.hubs
      .room(id)
      .then((lease) => {
        if (lease === undefined || this.stopped || this.leases.get(id) !== opening) {
          lease?.release();
          if (this.leases.get(id) === opening) this.leases.delete(id);
          return;
        }
        this.leases.set(id, lease);
        this.unlisten.set(
          id,
          lease.hub.listen({ changed: () => this.update(), ended: () => this.drop(id) }),
        );
        this.update();
      })
      .catch((error: unknown) => {
        if (this.leases.get(id) === opening) this.leases.delete(id);
        this.report(error);
      });
    this.leases.set(id, opening);
  }

  private drop(id: string): void {
    const lease = this.leases.get(id);
    this.leases.delete(id);
    this.unlisten.get(id)?.();
    this.unlisten.delete(id);
    this.rows.delete(id);
    if (lease !== undefined && !(lease instanceof Promise)) lease.release();
    this.update();
  }

  private row(hub: RoomHub): HomeRoom {
    const view = hub.view();
    const kept = this.rows.get(hub.roomId);
    if (kept?.view === view) return kept.row;
    const lastItemAt = view.timeline.reduce<number | undefined>((last, item) => {
      const at =
        item.type === "user" ? item.sentAt : item.type === "nudge" ? item.firedAt : undefined;
      return at === undefined || (last !== undefined && last >= at) ? last : at;
    }, undefined);
    const row: HomeRoom = {
      room: view.room,
      running: view.live.running,
      pendingApprovals: view.approvals.filter((approval) => approval.status === "pending").length,
      ...(lastItemAt === undefined ? {} : { lastItemAt }),
    };
    this.rows.set(hub.roomId, { view, row });
    return row;
  }

  private update(): void {
    if (this.stopped) return;
    this.projected = undefined;
    this.listeners.changed();
  }

  private usableRooms(): CoreRoom[] {
    return Object.values(this.directory.value.rooms)
      .filter((room) => canUse(room, this.playerId))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private projectPlayer(): Player {
    const player = this.directory.value.players[this.playerId];
    return toPlayer(player ?? { id: this.playerId, displayName: this.playerId });
  }
}
