import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Nudge, Player, RoomSocketSession } from "@nudge/core";
import { CLOSE } from "@nudge/protocol";
import { UsageError } from "./errors.ts";

const context = BACKGROUND_CONTEXT;

/** A frame from an extension's room socket; each extension has its own besides these. */
export type ExtensionFrame = { type: string; ref?: string; message?: string };

/**
 * A line to one extension's room socket, in this process or through a server: inputs carry a
 * `ref`, and the extension answers each with `{type: "ok"}` or `{type: "error", message}` under
 * that `ref` (as the connectors panel does).
 */
export class ExtensionChannel {
  private readonly frames: ExtensionFrame[] = [];
  private readonly waiters = new Set<() => void>();
  private refs = 0;
  private ended: string | undefined;

  private constructor(
    private readonly write: (data: string) => void,
    private readonly end: () => void,
  ) {}

  /** Calls the extension's handler here, as `player`. */
  static async local(
    nudge: Nudge,
    roomId: string,
    player: Player,
    extension: string,
    admin?: boolean,
  ): Promise<ExtensionChannel> {
    const room = await nudge.rooms.get(roomId, context);
    const handler = nudge.roomSocket(extension);
    if (
      room === undefined ||
      handler === undefined ||
      !(await nudge.extensionEnabled(room.id, extension, context))
    )
      throw new UsageError(`No extension "${extension}" in room "${roomId}"`);
    let session: RoomSocketSession | undefined;
    const channel: ExtensionChannel = new ExtensionChannel(
      (data) => session?.receive(data),
      () => session?.close(),
    );
    session = await handler(
      {
        room,
        player,
        admin: admin ?? (await nudge.players.isAdmin(player.id, context)),
      },
      {
        send: (data) => channel.received(nudge.showJsonTo(player.id, data)),
        close: (_code, reason) => channel.closed(reason ?? "closed"),
      },
    );
    return channel;
  }

  /** Opens the extension's socket on the server at `origin`, signed in with `token`. */
  static remote(
    origin: string,
    assistant: string,
    roomId: string,
    token: string,
    extension: string,
  ): Promise<ExtensionChannel> {
    const url = new URL(
      `/v1/a/${encodeURIComponent(assistant)}/rooms/${encodeURIComponent(roomId)}/ext/${encodeURIComponent(extension)}`,
      origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const channel = new ExtensionChannel(
      (data) => socket.send(data),
      () => socket.close(),
    );
    return new Promise((resolve, reject) => {
      let ready = false;
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", token })));
      socket.addEventListener("message", (event) => {
        if (!ready && (JSON.parse(String(event.data)) as ExtensionFrame).type === "ready") {
          ready = true;
          resolve(channel);
        } else channel.received(String(event.data));
      });
      socket.addEventListener("error", () => {
        if (!ready) reject(new UsageError(`Could not reach ${origin}`));
      });
      socket.addEventListener("close", (event) => {
        const why =
          event.code === CLOSE.notFound
            ? `No extension "${extension}" in room "${roomId}"`
            : event.code === CLOSE.unauthorized
              ? "The token was refused"
              : `${event.reason || "closed"} (${event.code})`;
        channel.closed(why);
        if (!ready) reject(new UsageError(why));
      });
    });
  }

  /** The newest frame of `type`, waiting for one if none came yet. */
  async latest<T extends ExtensionFrame>(type: string): Promise<T> {
    return (await this.until(() => this.frames.findLast((frame) => frame.type === type))) as T;
  }

  /** Sends one input; resolves on its `ok` and throws its `error` as a usage error. */
  async request(input: Record<string, unknown>): Promise<void> {
    const ref = `cli-${++this.refs}`;
    this.write(JSON.stringify({ ...input, ref }));
    const reply = await this.until(() => this.frames.find((frame) => frame.ref === ref));
    if (reply.type === "error") throw new UsageError(reply.message ?? "Refused");
  }

  close(): void {
    this.end();
  }

  private received(data: string): void {
    this.frames.push(JSON.parse(data) as ExtensionFrame);
    for (const wake of this.waiters) wake();
  }

  private closed(why: string): void {
    this.ended ??= why;
    for (const wake of this.waiters) wake();
  }

  private until(find: () => ExtensionFrame | undefined): Promise<ExtensionFrame> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const frame = find();
        if (frame !== undefined || this.ended !== undefined) this.waiters.delete(check);
        if (frame !== undefined) resolve(frame);
        else if (this.ended !== undefined) reject(new UsageError(this.ended));
      };
      this.waiters.add(check);
      check();
    });
  }
}
