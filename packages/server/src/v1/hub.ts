import {
  type Approval,
  BACKGROUND_CONTEXT,
  canUse,
  type Change,
  type Context,
  type ConversationView,
  type ConversationWatch,
  DirectoryDoc,
  type DirectoryState,
  type DocumentWatch,
  type LogFields,
  type Nudge,
  type Room as CoreRoom,
  type RoomFact,
  type ScheduledNudge,
} from "@nudge/core";
import type { RoomListEntry, RoomListView, Player, Room, RoomView } from "@nudge/protocol";
import { projectRoomList, RoomProjector, toPlayer, toRoom, Viewer } from "@nudge/protocol/project";

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
 * watches, one `RoomListHub` per player. Hubs open on first use and close when their last lease
 * goes.
 */
export class Hubs {
  private readonly rooms = new Shared<RoomHub>();
  private readonly roomLists = new Shared<RoomListHub>();
  private directory: Promise<Directory> | undefined;
  private readonly viewers = new Map<string, Viewer>();

  constructor(
    readonly nudge: Nudge,
    /** Told of what fails in the background, with the room it was for when there is one. */
    private readonly report: (error: unknown, fields?: LogFields) => void,
  ) {}

  /**
   * What a player may see of the views: the hubs project once for everyone, and each player's
   * copy goes through this before it leaves the server.
   */
  viewer(playerId: string): Viewer {
    let viewer = this.viewers.get(playerId);
    if (viewer === undefined) {
      viewer = new Viewer(
        playerId,
        (text) => this.nudge.showTo(playerId, text),
        () => this.nudge.vaultVersion,
      );
      this.viewers.set(playerId, viewer);
    }
    return viewer;
  }

  /** Counts a socket that has the room open for the player, until the returned function is called. */
  opened(playerId: string, roomId: string): () => void {
    return this.nudge.presence.opened(playerId, roomId);
  }

  /** `undefined` when the room does not exist. Whether the player may use it is the caller's check. */
  async room(roomId: string): Promise<Lease<RoomHub> | undefined> {
    if ((await this.nudge.rooms.get(roomId, context)) === undefined) return undefined;
    const directory = await this.openDirectory();
    return this.rooms.lease(roomId, () =>
      RoomHub.open(this.nudge, roomId, directory, (error) => this.report(error, { room: roomId })),
    );
  }

  /**
   * Calls `revoked` once the token of `clientId` stops working, as when an admin revokes it.
   * Returns a function that stops watching.
   */
  watchToken(clientId: string, revoked: () => void): Promise<() => void> {
    return this.watchDirectory(
      (directory) => Object.values(directory.tokens).some((record) => record.clientId === clientId),
      revoked,
    );
  }

  /**
   * Calls `lost` once `playerId` may no longer use the room, as when they leave it or it goes.
   * Returns a function that stops watching.
   */
  watchRoom(roomId: string, playerId: string, lost: () => void): Promise<() => void> {
    return this.watchDirectory((directory) => {
      const room = directory.rooms[roomId];
      return room !== undefined && canUse(room, playerId);
    }, lost);
  }

  async roomList(playerId: string): Promise<Lease<RoomListHub>> {
    const directory = await this.openDirectory();
    return this.roomLists.lease(playerId, () =>
      Promise.resolve(new RoomListHub(playerId, directory, this, this.report)),
    );
  }

  /** Calls `ended` once `holds` is false after a change to the directory. */
  private async watchDirectory(
    holds: (directory: Readonly<DirectoryState>) => boolean,
    ended: () => void,
  ): Promise<() => void> {
    const directory = await this.openDirectory();
    let stopped = false;
    const stop = directory.listen(() => {
      if (stopped || holds(directory.value)) return;
      stopped = true;
      stop();
      ended();
    });
    return () => {
      stopped = true;
      stop();
    };
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
 * `Nudge.changes` names the room, and whose location the model may know when a member's changes.
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
    private memory: readonly RoomFact[],
    private nudges: readonly ScheduledNudge[],
    private sharingLocation: readonly string[],
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
      const [approvals, memory, nudges, sharingLocation] = await Promise.all([
        nudge.approvals.list(roomId, context),
        nudge.memory.visible(roomId, context),
        nudge.nudges.list(context, [roomId]),
        nudge.personal.sharingIn(roomId, context),
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
        sharingLocation,
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
      sharingLocation: this.sharingLocation,
    });
    return this.projected;
  }

  /** The conversation as last committed: raw entries and pi-durable's documents. */
  conversationView(): ConversationView {
    return this.conversation;
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
        // Who may see which values changed: every viewer's copy is worked out again.
        if (change.kind === "vault") this.listeners.changed();
        else if (change.kind === "location") {
          if (this.core.members.includes(change.playerId)) this.read(["location"]);
        } else if ("roomId" in change && change.roomId === this.roomId) this.read([change.kind]);
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
    this.read(["approvals", "memory", "nudges", "location"]);
  }

  private read(kinds: readonly ("approvals" | "memory" | "nudges" | "location")[]): void {
    this.reading = this.reading
      .then(async () => {
        if (this.stopped) return;
        const [approvals, memory, nudges, sharingLocation] = await Promise.all([
          kinds.includes("approvals") ? this.nudge.approvals.list(this.roomId, context) : undefined,
          kinds.includes("memory") ? this.nudge.memory.visible(this.roomId, context) : undefined,
          kinds.includes("nudges") ? this.nudge.nudges.list(context, [this.roomId]) : undefined,
          kinds.includes("location")
            ? this.nudge.personal.sharingIn(this.roomId, context)
            : undefined,
        ]);
        if (this.stopped) return;
        if (approvals !== undefined) this.approvals = approvals;
        if (memory !== undefined) this.memory = memory;
        if (nudges !== undefined) this.nudges = nudges;
        if (sharingLocation !== undefined) this.sharingLocation = sharingLocation;
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
 * One player's `RoomListView`: the rooms they may use, each through its `RoomHub`, so room list
 * and room subscriptions share one watch per room. The player's nudges are their rooms' nudges.
 */
export class RoomListHub implements Hub<RoomListView> {
  private readonly listeners = new Listeners();
  private readonly leases = new Map<string, Lease<RoomHub> | Promise<void>>();
  private readonly unlisten = new Map<string, () => void>();
  private readonly rows = new Map<string, { view: RoomView; row: RoomListEntry }>();
  private projected: RoomListView | undefined;
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

  view(): RoomListView {
    if (this.projected !== undefined) return this.projected;
    const rooms: RoomListEntry[] = [];
    const nudges: ScheduledNudge[] = [];
    for (const room of this.usableRooms()) {
      const lease = this.leases.get(room.id);
      if (lease === undefined || lease instanceof Promise) continue;
      rooms.push(this.row(lease.hub));
      nudges.push(...lease.hub.nudgesNow());
    }
    this.projected = this.hubs.viewer(this.playerId).roomList(
      projectRoomList({
        player: this.player,
        rooms,
        nudges,
        appearance: this.directory.value.appearance,
      }),
    );
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

  private row(hub: RoomHub): RoomListEntry {
    // Counted as the player sees the room, so others' private approvals and messages don't show.
    const view = this.hubs.viewer(this.playerId).room(hub.view());
    const kept = this.rows.get(hub.roomId);
    if (kept?.view === view) return kept.row;
    const lastItemAt = view.timeline.reduce<number | undefined>((last, item) => {
      const at =
        item.type === "user" ? item.sentAt : item.type === "nudge" ? item.firedAt : undefined;
      return at === undefined || (last !== undefined && last >= at) ? last : at;
    }, undefined);
    const row: RoomListEntry = {
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
