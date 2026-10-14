import type { Message } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import {
  APPROVAL_ENTRY,
  type Approval,
  type ApprovalEntryData,
  FIRE_ENTRY,
  type FireEntryData,
  MESSAGE_ENTRY,
  type MessageEntryData,
  type ScheduledNudge,
} from "@nudge/core";

export type Line = { readonly who: string; readonly text: string };

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;

/** What a transcript entry shows in a chat, or undefined for entries a chat hides. */
export function entryLine(entry: EntryRecord, assistantName: string): Line | undefined {
  if (entry.kind === MESSAGE_ENTRY) {
    const data = entry.data as MessageEntryData;
    return { who: data.displayName, text: data.text };
  }
  if (entry.kind === FIRE_ENTRY)
    return { who: "nudge", text: (entry.data as FireEntryData).message };
  if (entry.kind === APPROVAL_ENTRY) {
    const data = entry.data as ApprovalEntryData;
    return {
      who: data.id,
      text: `${data.status} by ${data.decidedBy ?? "nobody"}: ${data.summary}`,
    };
  }
  const message = entry.model?.[0];
  if (message === undefined) return undefined;
  if (entry.kind === "pi.user") return { who: "you", text: messageText(message).trim() };
  if (entry.kind === "pi.assistant") {
    const text = messageText(message).trim();
    return text === "" ? undefined : { who: assistantName, text };
  }
  return undefined;
}

/** `a3 pending  Send a mail to Ann`, with who decided and what came of it once decided. */
export function describeApproval(approval: Approval): string {
  const who = approval.decidedBy === undefined ? "" : ` by ${approval.decidedBy.displayName}`;
  const result = approval.result === undefined ? "" : ` → ${approval.result.split("\n")[0]}`;
  return `${approval.id} ${approval.status}${who}  ${approval.summary}${result}`;
}

/** `12  Tue 13 Oct, 14:30, every 60 min  Water the plants`, in this machine's time zone. */
export function describeNudge(nudge: ScheduledNudge): string {
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

export function messageText(message: Message): string {
  if (message.role === "toolResult") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Turns an agent event stream into terminal text. Answers stream in as their deltas arrive;
 * messages from other clients print whole. Our own messages are already on screen.
 */
export class ChatRenderer {
  private streaming = false;
  /** Text of the current answer already on screen. */
  private shown = "";

  constructor(
    private readonly write: (text: string) => void,
    private readonly assistantName: string,
    private readonly ownClientId: string,
  ) {}

  history(snapshot: SnapshotEvent, limit = 20): void {
    const lines = snapshot.entries
      .map((entry) => entryLine(entry, this.assistantName))
      .filter((line) => line !== undefined)
      .slice(-limit);
    for (const line of lines) this.write(`${dim(`${line.who}:`)} ${dim(line.text)}\n`);
    const partial = snapshot.generation?.message;
    if (partial !== undefined) {
      this.startAnswer();
      this.show(messageText(partial));
    }
  }

  get busy(): boolean {
    return this.streaming;
  }

  event(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role !== "assistant") break;
        this.startAnswer();
        this.show(messageText(event.message));
        break;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta") this.show(this.shown + change.delta);
          else if (change.type === "text_start" && change.block.type === "text")
            this.show(this.shown + change.block.text);
        }
        break;
      case "message_end":
        this.endMessage(event.entry);
        break;
      case "tool_execution_start":
        this.endAnswer();
        this.write(dim(`  · ${event.toolName}\n`));
        break;
      case "auto_retry_start":
        this.endAnswer();
        this.write(dim(`  · retrying (${event.errorMessage})\n`));
        break;
      case "task_failed":
        this.endAnswer();
        this.write(`  ! ${event.kind} failed: ${event.message}\n`);
        break;
      case "entry_appended":
        this.endMessage(event.entry);
        break;
      default:
        break;
    }
  }

  private endMessage(entry: EntryRecord): void {
    if (entry.kind === "pi.assistant") {
      const message = entry.model?.[0];
      const text = message === undefined ? "" : messageText(message);
      if (text !== "") {
        this.startAnswer();
        this.show(text);
      }
      this.endAnswer();
      return;
    }
    if (entry.kind === FIRE_ENTRY) {
      this.endAnswer();
      this.write(dim(`  · nudge: ${(entry.data as FireEntryData).message}\n`));
      return;
    }
    if (entry.kind === APPROVAL_ENTRY) {
      const data = entry.data as ApprovalEntryData;
      this.endAnswer();
      this.write(
        dim(`  · ${data.id} ${data.status} by ${data.decidedBy ?? "nobody"}: ${data.summary}\n`),
      );
      return;
    }
    if (entry.kind !== MESSAGE_ENTRY) return;
    const data = entry.data as MessageEntryData;
    if (data.clientId === this.ownClientId) return;
    this.endAnswer();
    this.write(`${bold(`${data.displayName}:`)} ${data.text}\n`);
  }

  /** Prints what `text` adds to the answer on screen; a rewrite (a retry) starts a new line. */
  private show(text: string): void {
    if (text.startsWith(this.shown)) {
      this.write(text.slice(this.shown.length));
    } else {
      this.write(`\n${text}`);
    }
    this.shown = text;
  }

  private startAnswer(): void {
    if (this.streaming) return;
    this.streaming = true;
    this.write(`${bold(`${this.assistantName}:`)} `);
  }

  private endAnswer(): void {
    if (!this.streaming) return;
    this.streaming = false;
    this.shown = "";
    this.write("\n");
  }
}
