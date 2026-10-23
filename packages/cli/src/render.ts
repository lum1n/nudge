import type {
  Approval,
  RoomExtension,
  RoomNudge,
  RoomView,
  Status,
  TimelineItem,
} from "@nudge/protocol";

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;

/** `a3 pending  Send a mail to Ann`, with who decided and what came of it once decided. */
export function describeApproval(approval: Approval): string {
  const who = approval.decidedBy === undefined ? "" : ` by ${approval.decidedBy.displayName}`;
  const result = approval.result === undefined ? "" : ` → ${approval.result.split("\n")[0]}`;
  return `${approval.id} ${approval.status}${who}  ${approval.summary}${result}`;
}

/** `12  Tue 13 Oct, 14:30, every 60 min  Water the plants`, in this machine's time zone. */
export function describeNudge(nudge: RoomNudge): string {
  const when = new Date(nudge.fireAt).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const every = nudge.every === undefined ? "" : `, every ${Math.round(nudge.every / 60_000)} min`;
  return `${nudge.id}\t${when}${every}\t${nudge.message}`;
}

export function describeExtension(extension: RoomExtension): string {
  if (extension.error !== undefined)
    return `${extension.name}: broken, failed to start: ${extension.error}`;
  const state = extension.enabled ? "on" : "off";
  const chosen = extension.enabled === extension.byDefault ? "" : " (chosen here)";
  const about = extension.description === undefined ? "" : ` — ${extension.description}`;
  return `${extension.name}: ${state}${chosen}${about}`;
}

type Answer = Extract<TimelineItem, { type: "answer" }>;

/** A running tool's current step: the last line of its output so far, cut short. */
export function progressLine(output: string | undefined): string | undefined {
  const line = output
    ?.split("\n")
    .map((text) => text.trim())
    .findLast((text) => text !== "");
  if (line === undefined) return undefined;
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

/**
 * Turns a room's successive views into terminal text. Answers stream in as their text grows;
 * messages from other clients print whole. Our own messages are already on screen.
 */
export class ChatRenderer {
  /** Items printed for good. */
  private readonly done = new Set<string>();
  /** Per answer still running: how many of its parts are finished and printed. */
  private readonly progress = new Map<string, number>();
  /** Tool calls already announced. */
  private readonly tools = new Set<string>();
  /** The progress line last printed per running tool call. */
  private readonly doing = new Map<string, string>();
  /** The text part on screen now (`<answer id>/<index>`), and its text so far. */
  private streaming: string | undefined;
  private shown = "";
  private running = false;
  private status: string | undefined;

  constructor(
    private readonly write: (text: string) => void,
    private readonly assistantName: string,
    private readonly ownClientId: string,
  ) {}

  /** The first view: up to `limit` settled items, dimmed, then whatever is still streaming. */
  history(view: RoomView, limit = 20): void {
    const settled = view.timeline.filter(
      (item) => item.type !== "answer" || item.status !== "running",
    );
    for (const item of settled) this.done.add(item.id);
    const lines = settled.flatMap((item) => this.line(item) ?? []).slice(-limit);
    for (const line of lines) this.write(`${dim(line)}\n`);
    this.update(view);
  }

  /** Whether the assistant is answering. */
  get busy(): boolean {
    return this.running;
  }

  /** Prints what `view` adds; true when an answer just ended. */
  update(view: RoomView): boolean {
    for (const item of view.timeline) if (!this.done.has(item.id)) this.item(item);
    this.showStatus(view.live.status);
    const ended = this.running && !view.live.running;
    this.running = view.live.running;
    if (ended) this.endText();
    return ended;
  }

  /** A settled item as one history line, or undefined for one a chat hides. */
  private line(item: TimelineItem): string | undefined {
    switch (item.type) {
      case "user":
        return hidden(item)
          ? `· ${item.author?.displayName ?? "someone"} sent a private message`
          : `${item.author?.displayName ?? "you"}: ${mine(item)}${item.text}`;
      case "nudge":
        return hidden(item)
          ? `nudge for ${item.privateTo!.displayName}`
          : `nudge: ${mine(item)}${item.text}`;
      case "approval":
        return `${item.approvalId} ${item.status} by ${item.decidedBy ?? "nobody"}: ${item.summary}`;
      case "marker":
        return item.kind === "compacted" ? "· earlier messages summarized" : "· started over";
      case "answer": {
        if (item.privateTo !== undefined && item.parts.length === 0)
          return `answered ${item.privateTo.displayName} privately`;
        const text = item.parts
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("")
          .trim();
        return text === "" ? undefined : `${this.assistantName}: ${text}`;
      }
    }
  }

  private item(item: TimelineItem): void {
    if (item.type === "answer") return this.answer(item);
    this.done.add(item.id);
    if (item.type === "user") {
      if (item.clientId === this.ownClientId) return;
      this.endText();
      if (hidden(item))
        this.write(
          `${dim(`  · ${item.author?.displayName ?? "someone"} sent a private message`)}\n`,
        );
      else
        this.write(
          `${bold(`${item.author?.displayName ?? "someone"}:`)} ${mine(item)}${item.text}\n`,
        );
      return;
    }
    const line = this.line(item);
    if (line === undefined) return;
    this.endText();
    this.write(`${dim(`  · ${line}`)}\n`);
  }

  private answer(item: Answer): void {
    const settled = item.status !== "running";
    let next = this.progress.get(item.id) ?? 0;
    for (let index = next; index < item.parts.length; index++) {
      const part = item.parts[index]!;
      // A part is finished once another follows it, or the answer ended.
      const finished = settled || index < item.parts.length - 1;
      if (part.type === "text") {
        this.showText(`${item.id}/${index}`, part.text);
        if (finished) this.endText();
      } else if (part.type === "tool") {
        if (!this.tools.has(part.callId)) {
          this.tools.add(part.callId);
          this.endText();
          this.write(`${dim(`  · ${part.name}`)}\n`);
        }
        // What a running tool says it is doing, such as browse's `Clicking "Search"…`.
        const doing = part.status === "done" ? undefined : progressLine(part.output);
        if (doing !== undefined && this.doing.get(part.callId) !== doing) {
          this.doing.set(part.callId, doing);
          this.endText();
          this.write(`${dim(`    ${doing}`)}\n`);
        }
      }
      if (finished) next = index + 1;
    }
    if (!settled) {
      this.progress.set(item.id, next);
      return;
    }
    this.progress.delete(item.id);
    this.done.add(item.id);
    this.endText();
    if (item.privateTo !== undefined && item.parts.length === 0)
      this.write(
        `${dim(`  · ${this.assistantName} answered ${item.privateTo.displayName} privately`)}\n`,
      );
    else if (item.status === "failed") this.write(`  ! failed: ${item.error ?? "unknown error"}\n`);
    else if (item.status === "stopped") this.write(`${dim("  · stopped")}\n`);
  }

  private showStatus(status: Status | undefined): void {
    const key =
      status === undefined
        ? undefined
        : status.kind === "retrying"
          ? `retrying ${status.attempt}`
          : status.kind;
    if (key === this.status) return;
    this.status = key;
    if (status === undefined || status.kind === "compacting") return;
    this.endText();
    if (status.kind === "retrying") this.write(`${dim(`  · retrying (${status.error})`)}\n`);
    else this.write(`  ! compaction failed: ${status.error}\n`);
  }

  /** Prints what `text` adds to the part on screen; a rewrite (a retry) starts a new line. */
  private showText(part: string, text: string): void {
    if (this.streaming !== part) {
      this.endText();
      if (text === "") return;
      this.streaming = part;
      this.shown = "";
      this.write(`${bold(`${this.assistantName}:`)} `);
    }
    if (text.startsWith(this.shown)) this.write(text.slice(this.shown.length));
    else this.write(`\n${text}`);
    this.shown = text;
  }

  private endText(): void {
    if (this.streaming === undefined) return;
    this.streaming = undefined;
    this.shown = "";
    this.write("\n");
  }
}

/** Something private to someone else: the server sent it emptied. */
function hidden(item: Extract<TimelineItem, { type: "user" | "nudge" }>): boolean {
  return item.privateTo !== undefined && item.text === "";
}

/** Marks what is private to the reader, so they know the others don't see it. */
function mine(item: Extract<TimelineItem, { type: "user" | "nudge" }>): string {
  return item.privateTo === undefined ? "" : dim("(only you) ");
}

/** A connector as the connectors extension's panel sends it; never its key. */
export type Connector = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly useFor: string;
  readonly alwaysFirst?: boolean;
  readonly auth?: { readonly in: string; readonly name: string };
  readonly allowPrivateNetwork: boolean;
  readonly readPaths: readonly string[];
  readonly shared: boolean;
  readonly hasKey: boolean;
};

export function describeConnector(connector: Connector): string {
  const notes = [
    connector.alwaysFirst ? "always first" : undefined,
    connector.shared ? "shared with every room" : undefined,
    connector.auth === undefined ? undefined : connector.hasKey ? "key set" : "no key yet",
    connector.allowPrivateNetwork ? "may reach the local network" : undefined,
    connector.readPaths.length > 0 ? `reads: ${connector.readPaths.join(", ")}` : undefined,
  ].filter((note) => note !== undefined);
  return (
    `${connector.id}: ${connector.name} (${connector.baseUrl}) — ${connector.useFor}` +
    (notes.length === 0 ? "" : ` [${notes.join("; ")}]`)
  );
}
