import { BACKGROUND_CONTEXT, canUse, type RoomSocketSession } from "@nudge/core";
import { CLOSE } from "@nudge/protocol";
import type { WSContext } from "hono/ws";
import type { Hubs } from "./hub.ts";

const context = BACKGROUND_CONTEXT;

/**
 * One client of an extension's own socket for a room, such as the browser's live view: a
 * `{type: "hello", token}` frame first, then `{type: "ready"}` back and frames to and from the
 * extension. Bad tokens close with 4401; rooms the player may not use, and extensions without a
 * room socket, with 4404. Like the main socket, it closes with 4401 once the token is revoked, and
 * with 4404 once the player may no longer use the room.
 */
export class ExtensionSocket {
  private session: RoomSocketSession | undefined;
  private opening: Promise<void> | undefined;
  private closed = false;
  private readonly unwatch: (() => void)[] = [];

  constructor(
    private readonly hubs: Hubs,
    private readonly roomId: string,
    private readonly extension: string,
    private readonly report: (error: unknown) => void,
  ) {}

  receive(data: string, ws: WSContext): void {
    if (this.closed) return;
    if (this.session !== undefined) {
      this.session.receive(data);
      return;
    }
    // Frames that arrive while the hello is checked are dropped; clients wait for "ready".
    this.opening ??= this.hello(data, ws).catch((error: unknown) => {
      this.report(error);
      ws.close(1011, "Internal error");
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unwatch of this.unwatch) unwatch();
    this.session?.close();
  }

  private fail(ws: WSContext, code: number, reason: string): void {
    if (this.closed) return;
    ws.close(code, reason);
    this.close();
  }

  private async hello(data: string, ws: WSContext): Promise<void> {
    const nudge = this.hubs.nudge;
    let frame: { type?: unknown; token?: unknown };
    try {
      frame = JSON.parse(data) as typeof frame;
    } catch {
      ws.close(CLOSE.badRequest, "Frames are JSON");
      return;
    }
    const credential =
      frame.type === "hello" && typeof frame.token === "string"
        ? await nudge.players.authenticate(frame.token, context)
        : undefined;
    if (credential === undefined) {
      ws.close(CLOSE.unauthorized, "Missing or unknown token");
      return;
    }
    const room = await nudge.rooms.get(this.roomId, context);
    const handler = nudge.roomSocket(this.extension);
    if (
      room === undefined ||
      !canUse(room, credential.player.id) ||
      handler === undefined ||
      !(await nudge.extensionEnabled(room.id, this.extension, context))
    ) {
      ws.close(CLOSE.notFound, `No room "${this.roomId}" with extension "${this.extension}"`);
      return;
    }
    // Watched before the session opens, so a revoke or leave meanwhile still closes it.
    this.unwatch.push(
      await this.hubs.watchToken(credential.clientId, () =>
        this.fail(ws, CLOSE.unauthorized, "Token revoked"),
      ),
      await this.hubs.watchRoom(room.id, credential.player.id, () =>
        this.fail(ws, CLOSE.notFound, `No room "${this.roomId}"`),
      ),
    );
    if (this.closed) {
      for (const unwatch of this.unwatch) unwatch();
      return;
    }
    const session = await handler(
      {
        room,
        player: credential.player,
        admin: await nudge.players.isAdmin(credential.player.id, context),
      },
      {
        // As the player may see it, like the room's view: values others own stay hidden.
        send: (text) => {
          if (ws.readyState === 1) ws.send(nudge.showJsonTo(credential.player.id, text));
        },
        close: (code, reason) => ws.close(code, reason),
      },
    );
    if (this.closed) {
      session.close();
      return;
    }
    this.session = session;
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ready" }));
  }
}
