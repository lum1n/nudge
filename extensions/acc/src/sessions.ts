import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Owner } from "@nudge/core";
import type { Hosts } from "./hosts.ts";
import {
  type AccCommand,
  type AccEvent,
  type AccItem,
  type AccSession,
  accErrorCode,
  type HarnessId,
  type PermissionOption,
  type SessionState,
} from "./native.ts";

/** A session a room follows: it hears when the session finishes, fails or asks for permission. */
export type Follow = {
  readonly host: string;
  readonly id: string;
  readonly harness: HarnessId;
  readonly cwd: string;
  readonly roomId: string;
  /** Followed from a private conversation: only this player hears of it. */
  readonly privateTo?: Owner;
  /** Approvals asked for the session's permission requests, by request id. */
  approvals: Record<string, string>;
};

/** A request the session waits on someone for. */
export type Pending = {
  readonly requestId: string;
  readonly title: string;
  readonly options: readonly PermissionOption[];
  /** A question takes any text as its answer; a permission one of the options. */
  readonly kind: "permission" | "question" | "auth";
  readonly input?: unknown;
};

/** How following tells the rooms, which the extension supplies. */
export type Tell = {
  /** Gives the room input it answers; `key` makes a repeat after a restart find the first. */
  readonly post: (follow: Follow, key: string, content: string, message: string) => Promise<void>;
  /** Asks the room to approve a permission request; returns the approval's id. */
  readonly ask: (follow: Follow, pending: Pending) => Promise<string>;
  readonly report: (error: unknown) => void;
};

/** Text past this many characters of an agent's message is cut when told to the room. */
const MAX_TOLD = 1_500;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}

export function cut(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** The session's last answer, for telling a room what it finished with. */
export function lastAnswer(items: readonly AccItem[]): string | undefined {
  return items.findLast((item) => item.kind === "agent_message" && item.text.trim() !== "")?.text;
}

/**
 * One session the extension reads, for a room that follows it or for tools that act on it. The
 * log is replayed from the start when it attaches, which rebuilds the session's state; nothing is
 * told to a room about what happened before it caught up, except requests still waiting.
 */
export class Attachment {
  readonly pending = new Map<string, Pending>();
  follow: Follow | undefined;
  /** Set once the harness exited. */
  exit: { code: number | null } | undefined;
  private live = false;
  private readonly caughtUp: Promise<void>;
  private markCaughtUp!: () => void;
  private readonly stop = new AbortController();
  /** Requests a tool or approval here answered, so their resolution isn't news. */
  private readonly answered = new Set<string>();
  private loop: Promise<void> | undefined;

  constructor(
    readonly host: string,
    readonly harness: HarnessId,
    readonly cwd: string,
    readonly session: AccSession,
    private readonly tell: Tell,
    private readonly changed: () => void,
    private readonly ended: (attachment: Attachment) => void,
  ) {
    this.caughtUp = new Promise((resolve) => (this.markCaughtUp = resolve));
  }

  get id(): string {
    return this.session.id;
  }

  get state(): SessionState | null {
    return this.session.state();
  }

  /** Starts reading; a launched session is live from the start. */
  start(launched = false): void {
    this.loop ??= this.run(launched).catch(this.tell.report);
  }

  /** Waits until the replay reached the end of the log, or `ms` passed. */
  async ready(ms = 20_000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(resolve, ms, false)));
    try {
      return await Promise.race([this.caughtUp.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async send(command: AccCommand): Promise<void> {
    if (command.type === "answer_permission") this.answered.add(command.request_id);
    await this.session.send(command);
  }

  /** Starts telling `follow`'s room; asks about requests already waiting. */
  async setFollow(follow: Follow | undefined): Promise<void> {
    this.follow = follow;
    if (follow !== undefined && this.live) await this.askWaiting();
  }

  async close(): Promise<void> {
    this.stop.abort();
    // A read in progress can't be cancelled; it ends with the next output, which nobody needs.
  }

  private async run(launched: boolean): Promise<void> {
    let size = 0;
    if (!launched) {
      try {
        const status = await this.session.status();
        size = status.status === "missing" ? 0 : status.size;
      } catch (error) {
        this.tell.report(error);
      }
    }
    if (this.session.offset >= size) await this.goLive();
    while (!this.stop.signal.aborted && this.exit === undefined) {
      let events: AccEvent[];
      try {
        events = await this.session.nextEvents();
      } catch (error) {
        if (this.stop.signal.aborted) return;
        const code = accErrorCode(error);
        // What waiting won't mend.
        if (code === "HostKeyRejected" || code === "InvalidArgument" || code === "AuthRejected") {
          this.tell.report(error);
          return;
        }
        await sleep(5_000, this.stop.signal);
        continue;
      }
      if (this.stop.signal.aborted) return;
      for (const event of events) await this.handle(event).catch(this.tell.report);
      if (!this.live && this.session.offset >= size) await this.goLive();
    }
    if (this.exit !== undefined) this.ended(this);
  }

  private async goLive(): Promise<void> {
    this.live = true;
    this.markCaughtUp();
    await this.askWaiting();
  }

  /** Asks the room about requests that wait, unless it was asked already. */
  private async askWaiting(): Promise<void> {
    const follow = this.follow;
    if (follow === undefined) return;
    // Approvals for requests that were answered while nobody read the log are stale.
    let forgot = false;
    for (const requestId of Object.keys(follow.approvals))
      if (!this.pending.has(requestId)) {
        delete follow.approvals[requestId];
        forgot = true;
      }
    if (forgot) this.changed();
    for (const pending of this.pending.values()) await this.ask(pending);
  }

  private async ask(pending: Pending): Promise<void> {
    const follow = this.follow;
    if (follow === undefined || follow.approvals[pending.requestId] !== undefined) return;
    if (pending.kind !== "permission") {
      const options = pending.options.map((option) => option.label).join(" / ");
      await this.tell.post(
        follow,
        `ask:${pending.requestId}`,
        `The ${this.harness} session ${this.host}/${this.id} (in ${this.cwd}) asks: ${pending.title}` +
          (options === "" ? "" : `\nSuggested answers: ${options}`) +
          `\nAsk the room, then answer with acc_answer (request ${pending.requestId}).`,
        `${this.host}/${this.id} asks: ${cut(pending.title, 200)}`,
      );
      follow.approvals[pending.requestId] = "asked";
    } else follow.approvals[pending.requestId] = await this.tell.ask(follow, pending);
    this.changed();
  }

  private async handle(event: AccEvent): Promise<void> {
    const follow = this.follow;
    switch (event.type) {
      case "permission_requested": {
        const e = event as Extract<AccEvent, { type: "permission_requested" }>;
        const pending: Pending = {
          requestId: e.request_id,
          title: e.title,
          options: e.options,
          kind: e.kind ?? "permission",
          ...(e.input === undefined ? {} : { input: e.input }),
        };
        this.pending.set(e.request_id, pending);
        if (this.live) await this.ask(pending);
        return;
      }
      case "permission_resolved": {
        const { request_id } = event as Extract<AccEvent, { type: "permission_resolved" }>;
        const was = this.pending.get(request_id);
        this.pending.delete(request_id);
        const approval = follow?.approvals[request_id];
        if (follow === undefined || approval === undefined) return;
        delete follow.approvals[request_id];
        this.changed();
        if (
          this.live &&
          was !== undefined &&
          !this.answered.has(request_id) &&
          approval !== "asked"
        )
          await this.tell.post(
            follow,
            `resolved:${request_id}`,
            `Someone answered "${was.title}" in ${this.host}/${this.id} from elsewhere, so approval ` +
              `${approval} no longer matters.`,
            `${this.host}/${this.id}: answered elsewhere`,
          );
        this.answered.delete(request_id);
        return;
      }
      case "turn_completed": {
        if (!this.live || follow === undefined) return;
        const answer = lastAnswer(this.session.topLevelItems());
        await this.tell.post(
          follow,
          `turn:${this.session.offset}`,
          `The ${this.harness} session ${this.host}/${this.id} (in ${this.cwd}) finished its turn` +
            (answer === undefined ? "." : ` and said:\n${cut(answer, MAX_TOLD)}`) +
            "\nTell the room briefly; acc_read has the rest.",
          `${this.host}/${this.id} finished its turn`,
        );
        return;
      }
      case "state_changed": {
        const state = event as Extract<AccEvent, { type: "state_changed" }>;
        if (!this.live || follow === undefined || state.state.state !== "error") return;
        await this.tell.post(
          follow,
          `error:${this.session.offset}`,
          `The ${this.harness} session ${this.host}/${this.id} hit an error` +
            (state.message === null ? "." : `: ${cut(state.message, 500)}`) +
            "\nTell the room briefly.",
          `${this.host}/${this.id} hit an error`,
        );
        return;
      }
      case "exited": {
        const { code } = event as Extract<AccEvent, { type: "exited" }>;
        this.exit = { code };
        if (!this.live || follow === undefined) return;
        await this.tell.post(
          follow,
          "exited",
          `The ${this.harness} session ${this.host}/${this.id} (in ${this.cwd}) exited` +
            (code === null ? "." : ` with code ${code}.`) +
            " The room no longer follows it. Tell the room briefly.",
          `${this.host}/${this.id} exited`,
        );
        return;
      }
    }
  }
}

/** The sessions the extension reads, and which rooms follow which. */
export class Sessions {
  private readonly attached = new Map<string, Promise<Attachment>>();
  private follows: Follow[];

  constructor(
    private readonly hosts: Hosts,
    /** Where follows are kept; in memory only when absent. */
    private readonly file: string | undefined,
    private readonly tell: Tell,
  ) {
    this.follows = load(file);
  }

  /** Follows in `roomId`, or all. */
  followed(roomId?: string): Follow[] {
    return this.follows.filter((follow) => roomId === undefined || follow.roomId === roomId);
  }

  /** The attachment to `host`/`id` if the extension reads it already. */
  async current(host: string, id: string): Promise<Attachment | undefined> {
    return this.attached.get(key(host, id))?.catch(() => undefined);
  }

  /** Reads the session, attaching (and replaying its log) when nothing reads it yet. */
  attach(host: string, id: string): Promise<Attachment> {
    let attaching = this.attached.get(key(host, id));
    if (attaching === undefined) {
      attaching = this.open(host, id);
      this.attached.set(key(host, id), attaching);
      attaching.catch(() => this.attached.delete(key(host, id)));
    }
    return attaching;
  }

  /** Starts a harness on `host` as a new session and reads it. */
  async launch(
    host: string,
    id: string,
    harness: HarnessId,
    cwd: string,
    model: string | undefined,
  ): Promise<Attachment> {
    const connection = await this.hosts.connect(host);
    const session = await connection.launchSession(id, {
      harness,
      cwd,
      ...(model === undefined ? {} : { model }),
    });
    const attachment = this.make(host, harness, cwd, session);
    this.attached.set(key(host, id), Promise.resolve(attachment));
    attachment.start(true);
    return attachment;
  }

  /** Has `follow.roomId` follow the session; one room per session. */
  async follow(attachment: Attachment, follow: Omit<Follow, "approvals">): Promise<void> {
    const kept = this.follows.find((f) => f.host === follow.host && f.id === follow.id);
    const next: Follow = {
      ...follow,
      approvals: kept?.roomId === follow.roomId ? kept.approvals : {},
    };
    this.follows = [...this.follows.filter((f) => f !== kept), next];
    this.save();
    await attachment.setFollow(next);
  }

  async unfollow(host: string, id: string): Promise<boolean> {
    const before = this.follows.length;
    this.follows = this.follows.filter((f) => f.host !== host || f.id !== id);
    if (this.follows.length === before) return false;
    this.save();
    (await this.current(host, id))?.setFollow(undefined);
    return true;
  }

  /** Attaches every followed session, as after a restart. */
  async restore(): Promise<void> {
    for (const follow of this.follows)
      await this.attach(follow.host, follow.id).catch(this.tell.report);
  }

  async close(): Promise<void> {
    const all = [...this.attached.values()];
    this.attached.clear();
    await Promise.all(
      all.map((a) => a.then((attachment) => attachment.close()).catch(() => undefined)),
    );
  }

  private async open(host: string, id: string): Promise<Attachment> {
    const follow = this.follows.find((f) => f.host === host && f.id === id);
    const connection = await this.hosts.connect(host);
    let spec = follow === undefined ? undefined : { harness: follow.harness, cwd: follow.cwd };
    if (spec === undefined) {
      const listed = (await connection.listSessions()).find((session) => session.id === id);
      if (listed === undefined) throw new Error(`No session "${id}" on ${host}.`);
      if (listed.spec === null)
        throw new Error(
          `Session "${id}" on ${host} was started by an older ACC; it can't be read.`,
        );
      spec = { harness: listed.spec.harness, cwd: listed.spec.cwd };
    }
    const attachment = this.make(host, spec.harness, spec.cwd, connection.attachSession(id, spec));
    if (follow !== undefined) await attachment.setFollow(follow);
    attachment.start();
    return attachment;
  }

  private make(host: string, harness: HarnessId, cwd: string, session: AccSession): Attachment {
    return new Attachment(
      host,
      harness,
      cwd,
      session,
      this.tell,
      () => this.save(),
      (ended) => {
        // An exited session is followed no more; a later attach replays it afresh.
        this.attached.delete(key(ended.host, ended.id));
        if (ended.follow !== undefined) void this.unfollow(ended.host, ended.id);
      },
    );
  }

  private save(): void {
    if (this.file === undefined) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.follows, null, 2)}\n`);
  }
}

function key(host: string, id: string): string {
  return `${host}/${id}`;
}

function load(file: string | undefined): Follow[] {
  if (file === undefined) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Follow[];
  } catch {
    return [];
  }
}
