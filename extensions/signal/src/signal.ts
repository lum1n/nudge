import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { Inbound, Transport } from "@nudge/bridge";

/** The parts of signal-cli's `receive` envelope the bridge reads. */
export type Envelope = {
  source?: string;
  sourceNumber?: string | null;
  sourceUuid?: string;
  sourceName?: string;
  timestamp: number;
  dataMessage?: { message?: string | null; groupInfo?: { groupId: string } };
};

/** Signal's own limit is far higher; long messages read badly on a phone anyway. */
const MAX_LENGTH = 4000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_MS = 300_000;
const GROUP = "group.";

/**
 * A connection to `signal-cli daemon --tcp`: line-delimited JSON-RPC both ways, received messages
 * arriving as `receive` notifications. Reconnects until closed.
 */
export class SignalCli implements Transport {
  readonly name = "signal";
  readonly maxLength = MAX_LENGTH;
  readonly buttons = false;
  private socket: Socket | undefined;
  private next = 1;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private closed = false;

  constructor(
    private readonly address: { readonly host: string; readonly port: number },
    /** The daemon's account, in multi-account mode; absent when it runs with `-a`. */
    private readonly account: string | undefined,
    private readonly onEnvelope: (envelope: Envelope) => void,
    private readonly report: (error: unknown) => void,
  ) {}

  /**
   * Connects, and keeps reconnecting after a drop: `retryMs` after it, doubling with each failed
   * try in a row up to `MAX_RETRY_MS`.
   */
  start(retryMs = 5_000): void {
    let failures = 0;
    const retry = () => {
      if (this.closed) return;
      setTimeout(attempt, Math.min(retryMs * 2 ** failures++, MAX_RETRY_MS));
    };
    const attempt = () => {
      if (this.closed) return;
      this.connect().then(
        (socket) => {
          failures = 0;
          socket.once("close", retry);
        },
        (error: unknown) => {
          this.report(error);
          retry();
        },
      );
    };
    attempt();
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
  }

  async request<T>(method: string, params: object): Promise<T> {
    if (this.socket === undefined || this.socket.destroyed)
      throw new Error("signal: not connected to signal-cli");
    const id = String(this.next++);
    const socket = this.socket;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`signal: ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const body = this.account === undefined ? params : { ...params, account: this.account };
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: body })}\n`);
    });
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    const target = chatId.startsWith(GROUP)
      ? { groupId: chatId.slice(GROUP.length) }
      : { recipient: [chatId] };
    const result = await this.request<{ timestamp?: number }>("send", { ...target, message: text });
    return result?.timestamp === undefined ? undefined : String(result.timestamp);
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.address);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        socket.on("error", (error) => this.report(error));
        this.socket = socket;
        const lines = createInterface({ input: socket });
        lines.on("line", (line) => {
          // A throw here would be an uncaught exception, taking the whole host down.
          try {
            this.line(line);
          } catch (error) {
            this.report(error);
          }
        });
        socket.once("close", () => {
          for (const { reject } of this.pending.values())
            reject(new Error("signal: connection to signal-cli closed"));
          this.pending.clear();
        });
        resolve(socket);
      });
    });
  }

  private line(line: string): void {
    let message: {
      id?: string | number;
      method?: string;
      params?: { envelope?: Envelope; result?: { envelope?: Envelope } };
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiting = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      if (message.error !== undefined)
        waiting?.reject(new Error(`signal: ${message.error.message ?? "request failed"}`));
      else waiting?.resolve(message.result);
      return;
    }
    if (message.method !== "receive") return;
    // Automatic receiving sends the envelope; a subscription wraps it in `result`.
    const envelope = message.params?.envelope ?? message.params?.result?.envelope;
    if (envelope !== undefined) this.onEnvelope(envelope);
  }
}

/** What the bridge reads from an envelope; undefined for receipts, typing, syncs and the like. */
export function toInbound(envelope: Envelope): Inbound | undefined {
  const text = envelope.dataMessage?.message;
  const senderId = envelope.sourceUuid ?? envelope.sourceNumber ?? envelope.source;
  if (typeof text !== "string" || senderId === undefined || senderId === null) return undefined;
  const group = envelope.dataMessage?.groupInfo?.groupId;
  return {
    type: "message",
    chat:
      group === undefined ? { id: senderId, private: true } : { id: GROUP + group, private: false },
    sender: { id: senderId, name: envelope.sourceName || senderId },
    text,
    id: String(envelope.timestamp),
  };
}

/** `host:port`, the port defaulting to signal-cli's 7583. */
export function parseAddress(text: string): { host: string; port: number } {
  const match = /^(.*?)(?::(\d+))?$/.exec(text.trim());
  const host = match?.[1] || "127.0.0.1";
  return { host: host.replace(/^\[(.*)\]$/, "$1"), port: Number(match?.[2] ?? 7583) };
}
