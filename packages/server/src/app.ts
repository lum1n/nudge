import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentEventStream, Cursor } from "@earendil-works/pi-durable";
import { upgradeWebSocket } from "@hono/node-server";
import { canUse, type Credential, type Nudge, type Room } from "@nudge/core";
import { type Context as HonoContext, Hono, type MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";
import {
  CLOSE,
  type ClientFrame,
  type CreateRoomRequest,
  type MeResponse,
  type MessageRequest,
  type MessageResponse,
  type ProtectRequest,
  type ProtectResponse,
  type RoomResponse,
  type ServerFrame,
  type TranscriptResponse,
  type WhenBusy,
} from "./protocol.ts";

export type AppOptions = {
  /** By URL name: `/a/<name>/…`. */
  readonly assistants: ReadonlyMap<string, Nudge>;
  readonly onError?: (error: unknown) => void;
};

type Env = {
  Variables: {
    name: string;
    nudge: Nudge;
    credential: Credential;
  };
};

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404,
    message: string,
  ) {
    super(message);
  }
}

const context: Context = BACKGROUND_CONTEXT;

/** The Nudge HTTP and WebSocket API over one or more assistants. */
export function createApp(options: AppOptions): Hono<Env> {
  const app = new Hono<Env>();
  const report = options.onError ?? ((error) => console.error(error));

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    report(error);
    return c.json({ error: "Internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  const findAssistant: MiddlewareHandler<Env> = async (c, next) => {
    const name = c.req.param("assistant") ?? "";
    const assistant = options.assistants.get(name);
    if (assistant === undefined) throw new HttpError(404, `No assistant "${name}"`);
    c.set("name", name);
    c.set("nudge", assistant);
    await next();
  };

  const authenticate: MiddlewareHandler<Env> = async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const credential =
      token === undefined ? undefined : await c.var.nudge.players.authenticate(token, context);
    if (credential === undefined) throw new HttpError(401, "Missing or unknown token");
    c.set("credential", credential);
    await next();
  };

  // The stream authenticates with its first frame: browsers cannot set headers on a WebSocket.
  app.get(
    "/a/:assistant/rooms/:room/stream",
    findAssistant,
    upgradeWebSocket((c) => {
      const stream = new RoomStream(c.var.nudge, c.req.param("room") ?? "", report);
      return {
        onMessage: (event, ws) => stream.receive(event.data, ws),
        onClose: () => stream.close(),
        onError: () => stream.close(),
      };
    }),
  );

  const api = new Hono<Env>();
  api.use(findAssistant, authenticate);

  api.get("/me", async (c) => {
    const { player, clientId } = c.var.credential;
    const rooms = await c.var.nudge.rooms.list(context, player.id);
    return c.json({
      assistant: { name: c.var.name, displayName: c.var.nudge.displayName },
      player,
      clientId,
      rooms,
    } satisfies MeResponse);
  });

  api.get("/rooms", async (c) =>
    c.json(await c.var.nudge.rooms.list(context, c.var.credential.player.id)),
  );

  api.post("/rooms", async (c) => {
    const body = await readJson<CreateRoomRequest>(c);
    if (typeof body.name !== "string" || body.name.trim() === "")
      throw new HttpError(400, "A room needs a name");
    const me = c.var.credential.player.id;
    try {
      const room = await c.var.nudge.rooms.createShared(
        { name: body.name.trim(), members: [me, ...(body.members ?? [])], id: body.id },
        context,
      );
      return c.json(room, 201);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  api.post("/rooms/personal", async (c) =>
    c.json(await c.var.nudge.rooms.ensurePersonal(c.var.credential.player.id, context)),
  );

  api.get("/rooms/:room", async (c) => {
    const room = await usableRoom(c);
    const members = await c.var.nudge.rooms.members(room.id, context);
    return c.json({ room, members } satisfies RoomResponse);
  });

  api.post("/rooms/:room/messages", async (c) => {
    const room = await usableRoom(c);
    const body = await readJson<MessageRequest>(c);
    const submissionId = await submit(c.var.nudge, room, c.var.credential, body);
    return c.json({ submissionId } satisfies MessageResponse, 202);
  });

  api.post("/rooms/:room/abort", async (c) => {
    const room = await usableRoom(c);
    await c.var.nudge.abort(room.id, context);
    return c.body(null, 204);
  });

  api.get("/rooms/:room/transcript", async (c) => {
    const room = await usableRoom(c);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
    const before = c.req.query("before");
    let cursor: Cursor | undefined;
    try {
      cursor =
        before === undefined
          ? undefined
          : (JSON.parse(Buffer.from(before, "base64url").toString("utf8")) as Cursor);
    } catch {
      throw new HttpError(400, "Bad cursor");
    }
    const conversation = await c.var.nudge.conversation(room.id, context);
    const page = await conversation.entries({}, limit, cursor, context);
    return c.json({
      entries: page.items,
      ...(page.next === undefined
        ? {}
        : { next: Buffer.from(JSON.stringify(page.next)).toString("base64url") }),
    } satisfies TranscriptResponse);
  });

  api.post("/protect", async (c) => {
    const body = await readJson<ProtectRequest>(c);
    if (typeof body.value !== "string" || body.value.trim() === "")
      throw new HttpError(400, "Nothing to protect");
    if (body.kind !== undefined && !/^[A-Z]+$/.test(body.kind))
      throw new HttpError(400, "A kind is upper-case letters");
    const placeholder = await c.var.nudge.protect(body.value.trim(), body.kind);
    return c.json({ placeholder } satisfies ProtectResponse);
  });

  app.route("/a/:assistant", api);
  return app;
}

/** The room in the path, if the caller may use it. Rooms they may not use do not exist for them. */
async function usableRoom(c: HonoContext<Env>): Promise<Room> {
  const id = c.req.param("room") ?? "";
  const room = await c.var.nudge.rooms.get(id, context);
  if (room === undefined || !canUse(room, c.var.credential.player.id))
    throw new HttpError(404, `No room "${id}"`);
  return room;
}

async function readJson<T>(c: HonoContext<Env>): Promise<Partial<T>> {
  try {
    const body: unknown = await c.req.json();
    if (typeof body !== "object" || body === null) throw new Error();
    return body as Partial<T>;
  } catch {
    throw new HttpError(400, "Expected a JSON object");
  }
}

const WHEN_BUSY: readonly WhenBusy[] = ["steer", "followUp", "reject"];

async function submit(
  nudge: Nudge,
  room: Room,
  { player, clientId }: Credential,
  body: Partial<MessageRequest>,
): Promise<number> {
  if (typeof body.text !== "string" || body.text.trim() === "")
    throw new HttpError(400, "A message needs text");
  if (body.whenBusy !== undefined && !WHEN_BUSY.includes(body.whenBusy))
    throw new HttpError(400, `whenBusy is one of ${WHEN_BUSY.join(", ")}`);
  if (body.requestId !== undefined && typeof body.requestId !== "string")
    throw new HttpError(400, "requestId is a string");
  const submission = await nudge.submit(
    room.id,
    {
      text: body.text,
      // The author is whoever the token belongs to, never what the body says.
      author: { playerId: player.id, displayName: player.displayName, clientId },
      // Scoped to the client so one player's ids cannot collide with another's.
      requestId: body.requestId === undefined ? undefined : `${clientId}:${body.requestId}`,
      whenBusy: body.whenBusy,
    },
    context,
  );
  return submission.id;
}

/** One WebSocket client of one room: hello, then events out and submits in. */
class RoomStream {
  private credential: Credential | undefined;
  private room: Room | undefined;
  private events: AgentEventStream | undefined;
  private closed = false;
  /** Frames are handled one at a time, in order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly nudge: Nudge,
    private readonly roomId: string,
    private readonly report: (error: unknown) => void,
  ) {}

  receive(data: unknown, ws: WSContext): void {
    this.queue = this.queue
      .then(() => this.handle(data, ws))
      .catch((error: unknown) => {
        this.report(error);
        send(ws, { type: "error", message: "Internal error" });
      });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.events?.stop();
  }

  private async handle(data: unknown, ws: WSContext): Promise<void> {
    if (this.closed) return;
    let frame: ClientFrame;
    try {
      frame = JSON.parse(String(data)) as ClientFrame;
    } catch {
      ws.close(CLOSE.badRequest, "Frames are JSON");
      return;
    }
    if (this.credential === undefined) {
      await this.hello(frame, ws);
      return;
    }
    switch (frame.type) {
      case "submit":
        try {
          const submissionId = await submit(this.nudge, this.room!, this.credential, frame);
          send(ws, { type: "submitted", requestId: frame.requestId, submissionId });
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          send(ws, { type: "error", message: error.message, requestId: frame.requestId });
        }
        return;
      case "abort":
        await this.nudge.abort(this.room!.id, context);
        return;
      default:
        send(ws, {
          type: "error",
          message: `Unknown frame "${(frame as { type: unknown }).type}"`,
        });
    }
  }

  private async hello(frame: ClientFrame, ws: WSContext): Promise<void> {
    const credential =
      frame.type === "hello" && typeof frame.token === "string"
        ? await this.nudge.players.authenticate(frame.token, context)
        : undefined;
    if (credential === undefined) {
      ws.close(CLOSE.unauthorized, "Missing or unknown token");
      return;
    }
    const room = await this.nudge.rooms.get(this.roomId, context);
    if (room === undefined || !canUse(room, credential.player.id)) {
      ws.close(CLOSE.notFound, `No room "${this.roomId}"`);
      return;
    }
    this.credential = credential;
    this.room = room;
    const events = await this.nudge.attach(room.id, context);
    if (this.closed) {
      await events.stop();
      return;
    }
    this.events = events;
    send(ws, events.snapshot);
    events.start(async (batch) => send(ws, { type: "events", events: batch }));
    void events.closed.then((end) => {
      if (end.reason !== "stopped" && !this.closed) ws.close(CLOSE.goingAway, end.reason);
    });
  }
}

function send(ws: WSContext, frame: ServerFrame): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(frame));
}
