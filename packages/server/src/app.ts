import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { encoder } from "@earendil-works/chord/delta";
import type { Cursor } from "@earendil-works/pi-durable";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  AlreadyDecided,
  ApprovalNotFound,
  canUse,
  type Credential,
  type Nudge,
  type Room,
  type RoomSocketSession,
} from "@nudge/core";
import { type Context as HonoContext, Hono, type MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";
import {
  type ApprovalsResponse,
  type AssistantsResponse,
  CLOSE,
  type ClientFrame,
  type CreateRoomRequest,
  type DecideRequest,
  type MeResponse,
  type MemoryResponse,
  type MessageRequest,
  type MessageResponse,
  type NudgesResponse,
  type ProtectRequest,
  type ProtectResponse,
  type RememberRequest,
  type RoomResponse,
  type ServerFrame,
  type TranscriptResponse,
  type WhenBusy,
} from "./protocol.ts";
import { publicOps, publicView } from "./view.ts";

export type AppOptions = {
  /** By URL name: `/a/<name>/…`. */
  readonly assistants: ReadonlyMap<string, Nudge>;
  /** A built web UI (a directory with `index.html`) to serve at every path outside `/a`. */
  readonly web?: string;
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
    readonly status: 400 | 401 | 404 | 409,
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

  app.get("/a", (c) =>
    c.json({
      assistants: [...options.assistants].map(([name, nudge]) => ({
        name,
        displayName: nudge.displayName,
      })),
    } satisfies AssistantsResponse),
  );

  // The stream authenticates with its first frame: browsers cannot set headers on a WebSocket.
  app.get(
    "/a/:assistant/rooms/:room/stream",
    findAssistant,
    upgradeWebSocket((c) => {
      const format = c.req.query("format") === "view" ? "view" : "events";
      const stream = new RoomStream(c.var.nudge, c.req.param("room") ?? "", format, report);
      return {
        onMessage: (event, ws) => stream.receive(event.data, ws),
        onClose: () => stream.close(),
        onError: () => stream.close(),
      };
    }),
  );

  // An extension's own socket for a room; same hello-frame auth and room check as the stream.
  app.get(
    "/a/:assistant/rooms/:room/ext/:extension",
    findAssistant,
    upgradeWebSocket((c) => {
      const socket = new ExtensionSocket(
        c.var.nudge,
        c.req.param("room") ?? "",
        c.req.param("extension") ?? "",
        report,
      );
      return {
        onMessage: (event, ws) => socket.receive(String(event.data), ws),
        onClose: () => socket.close(),
        onError: () => socket.close(),
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

  api.get("/rooms/:room/memory", async (c) => {
    const room = await usableRoom(c);
    const facts = await c.var.nudge.memory.list(room.id, context);
    return c.json({ facts } satisfies MemoryResponse);
  });

  api.post("/rooms/:room/memory", async (c) => {
    const room = await usableRoom(c);
    const body = await readJson<RememberRequest>(c);
    if (typeof body.text !== "string" || body.text.trim() === "")
      throw new HttpError(400, "A fact needs text");
    try {
      return c.json(await c.var.nudge.memory.remember(room.id, body.text, context), 201);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  api.delete("/rooms/:room/memory/:id", async (c) => {
    const room = await usableRoom(c);
    const id = c.req.param("id");
    if (!(await c.var.nudge.memory.forget(room.id, id, context)))
      throw new HttpError(404, `No fact "${id}"`);
    return c.body(null, 204);
  });

  api.get("/rooms/:room/approvals", async (c) => {
    const room = await usableRoom(c);
    const approvals = await c.var.nudge.approvals.list(room.id, context);
    return c.json({ approvals } satisfies ApprovalsResponse);
  });

  api.post("/rooms/:room/approvals/:id", async (c) => {
    const room = await usableRoom(c);
    const body = await readJson<DecideRequest>(c);
    if (typeof body.approve !== "boolean") throw new HttpError(400, "Say approve: true or false");
    const { player } = c.var.credential;
    try {
      const approval = await c.var.nudge.approvals.decide(
        room.id,
        c.req.param("id"),
        { approve: body.approve, by: { playerId: player.id, displayName: player.displayName } },
        context,
      );
      return c.json(approval);
    } catch (error) {
      if (error instanceof ApprovalNotFound) throw new HttpError(404, error.message);
      if (error instanceof AlreadyDecided) throw new HttpError(409, error.message);
      throw error;
    }
  });

  api.get("/nudges", async (c) => {
    const rooms = await c.var.nudge.rooms.list(context, c.var.credential.player.id);
    const nudges = await c.var.nudge.nudges.list(
      context,
      rooms.map((room) => room.id),
    );
    return c.json({ nudges } satisfies NudgesResponse);
  });

  api.delete("/nudges/:id", async (c) => {
    const id = c.req.param("id");
    const nudge = await c.var.nudge.nudges.get(id, context);
    const room =
      nudge === undefined ? undefined : await c.var.nudge.rooms.get(nudge.roomId, context);
    if (room === undefined || !canUse(room, c.var.credential.player.id))
      throw new HttpError(404, `No nudge "${id}"`);
    await c.var.nudge.nudges.cancel(id, context);
    return c.body(null, 204);
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
  if (options.web !== undefined) serveWeb(app, options.web);
  return app;
}

/** Files from the build, and `index.html` for every other page so the browser's router takes over. */
function serveWeb(app: Hono<Env>, root: string): void {
  const outsideApi: MiddlewareHandler<Env> = async (c, next) => {
    if (c.req.path === "/a" || c.req.path.startsWith("/a/")) return c.notFound();
    await next();
  };
  app.get("*", outsideApi, serveStatic({ root }), async (c) => {
    const page = await readFile(join(root, "index.html"), "utf8").catch(() => undefined);
    return page === undefined ? c.notFound() : c.html(page);
  });
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
      requestId: body.requestId,
      whenBusy: body.whenBusy,
    },
    context,
  );
  return submission.id;
}

/** One WebSocket client of one room: hello, then events or the view out, and submits in. */
class RoomStream {
  private credential: Credential | undefined;
  private room: Room | undefined;
  private stop: (() => Promise<unknown>) | undefined;
  private closed = false;
  /** Frames are handled one at a time, in order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly nudge: Nudge,
    private readonly roomId: string,
    private readonly format: "events" | "view",
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
    void this.stop?.();
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
    const watch =
      this.format === "view" ? await this.watchView(room, ws) : await this.watchEvents(room, ws);
    if (this.closed) {
      await watch.stop();
      return;
    }
    this.stop = watch.stop;
    watch.start();
    void watch.closed.then((end) => {
      if (end.reason !== "stopped" && !this.closed) ws.close(CLOSE.goingAway, end.reason);
    });
  }

  private async watchEvents(room: Room, ws: WSContext): Promise<Watch> {
    const events = await this.nudge.attach(room.id, context);
    return {
      start: () => {
        send(ws, events.snapshot);
        events.start(async (batch) => send(ws, { type: "events", events: batch }));
      },
      stop: () => events.stop(),
      closed: events.closed,
    };
  }

  private async watchView(room: Room, ws: WSContext): Promise<Watch> {
    const watch = await this.nudge.watchRoom(room.id, context);
    // Paths are interned per socket, so the client needs every encoded frame, in order.
    const ops = encoder();
    return {
      start: () => {
        send(ws, { type: "view", value: publicView(watch.value) });
        watch.start(async (_value, batch) => {
          const visible = publicOps(batch);
          if (visible.length > 0) send(ws, { type: "ops", ops: ops.encode(visible) });
        });
      },
      stop: () => watch.stop(),
      closed: watch.closed,
    };
  }
}

/** One client of an extension's room socket: hello, then frames to and from the extension. */
class ExtensionSocket {
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
    if (room === undefined || !canUse(room, credential.player.id) || handler === undefined) {
      ws.close(CLOSE.notFound, `No room "${this.roomId}" with extension "${this.extension}"`);
      return;
    }
    const session = await handler(
      { room, player: credential.player },
      {
        send: (text) => {
          if (ws.readyState === 1) ws.send(text);
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

/** A started stream of one of the two formats. */
type Watch = {
  readonly start: () => void;
  readonly stop: () => Promise<unknown>;
  readonly closed: Promise<{ readonly reason: string }>;
};

function send(ws: WSContext, frame: ServerFrame): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(frame));
}
