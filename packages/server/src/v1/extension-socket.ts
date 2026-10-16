import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { canUse, type Nudge, type RoomSocketSession } from "@nudge/core";
import { CLOSE } from "@nudge/protocol";
import type { WSContext } from "hono/ws";

const context = BACKGROUND_CONTEXT;

/**
 * One client of an extension's own socket for a room, such as the browser's live view: a
 * `{type: "hello", token}` frame first, then `{type: "ready"}` back and frames to and from the
 * extension. Bad tokens close with 4401; rooms the player may not use, and extensions without a
 * room socket, with 4404.
 */
export class ExtensionSocket {
  private session: RoomSocketSession | undefined;
  private opening: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly nudge: Nudge,
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
    this.session?.close();
  }

  private async hello(data: string, ws: WSContext): Promise<void> {
    let frame: { type?: unknown; token?: unknown };
    try {
      frame = JSON.parse(data) as typeof frame;
    } catch {
      ws.close(CLOSE.badRequest, "Frames are JSON");
      return;
    }
    const credential =
      frame.type === "hello" && typeof frame.token === "string"
        ? await this.nudge.players.authenticate(frame.token, context)
        : undefined;
    if (credential === undefined) {
      ws.close(CLOSE.unauthorized, "Missing or unknown token");
      return;
    }
    const room = await this.nudge.rooms.get(this.roomId, context);
    const handler = this.nudge.roomSocket(this.extension);
    if (
      room === undefined ||
      !canUse(room, credential.player.id) ||
      handler === undefined ||
      !(await this.nudge.extensionEnabled(room.id, this.extension, context))
    ) {
      ws.close(CLOSE.notFound, `No room "${this.roomId}" with extension "${this.extension}"`);
      return;
    }
    const session = await handler(
      {
        room,
        player: credential.player,
        admin: await this.nudge.players.isAdmin(credential.player.id, context),
      },
      {
        // As the player may see it, like the room's view: values others own stay hidden.
        send: (text) => {
          if (ws.readyState === 1) ws.send(this.nudge.showJsonTo(credential.player.id, text));
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
