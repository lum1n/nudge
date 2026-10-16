import type { Cursor, EntryId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AlreadyDecided,
  ApprovalNotFound,
  BudgetReached,
  canUse,
  ConfigError,
  type Credential,
  ExtensionNotFound,
  type Nudge,
  type Player as CorePlayer,
  type Room as CoreRoom,
  type TokenRecord,
} from "@nudge/core";
import {
  AdminCreateRoomRequest,
  type AdminPlayer,
  type AssistantsResponse,
  CreatePlayerRequest,
  CreateRoomRequest,
  DecideRequest,
  decodeCursor,
  DeviceRequest,
  type DevicesResponse,
  type ExtensionSetup,
  type ExtensionSetupsResponse,
  encodeCursor,
  IssueTokenRequest,
  type MeResponse,
  MessageRequest,
  type MessageResponse,
  type ModelViewResponse,
  type NudgesResponse,
  PairingCodeRequest,
  type PairingCodeResponse,
  PairRequest,
  type PairResponse,
  type PlayerMemoryResponse,
  type PlayerResponse,
  type PlayersResponse,
  ProtectRequest,
  type ProtectResponse,
  type PushKeyResponse,
  PushRenewRequest,
  PushSubscribeRequest,
  RememberRequest,
  SaveExtensionSetupsRequest,
  type Room,
  type RoomExtensionsResponse,
  type RoomsResponse,
  SetAdminRequest,
  ShareMemoryRequest,
  SetRoomExtensionRequest,
  type TimelineResponse,
  type TokenInfo,
  type TokensResponse,
  type UsageResponse,
} from "@nudge/protocol";
import {
  TimelinePager,
  toApproval,
  toFact,
  toHomeNudge,
  toPlayer,
  toRoom,
  windowStart,
} from "@nudge/protocol/project";
import { type Context as HonoContext, Hono, type MiddlewareHandler } from "hono";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { BadSubscription, type Pushes } from "../push/pushes.ts";
import type { Hubs } from "./hub.ts";

const context = BACKGROUND_CONTEXT;

export type RestOptions = {
  readonly assistants: ReadonlyMap<string, Nudge>;
  readonly hubsOf: (nudge: Nudge) => Hubs;
  /** Web Push for the assistant; undefined when the server sends none. */
  readonly pushesOf?: (nudge: Nudge) => Pushes | undefined;
  /** The server's address as clients reach it, for pairing links; default the request's origin. */
  readonly publicUrl?: string;
  /** Setting up extensions from a client; the admin's settings routes answer 404 without. */
  readonly extensionSettings?: ExtensionSettings;
};

/**
 * Where an assistant's extensions are set up, such as the config file `nudge serve` read. A
 * `ConfigError` from either is the caller's mistake.
 */
export type ExtensionSettings = {
  list(assistant: string): Promise<ExtensionSetup[]>;
  /** Installs `extensions` in place of the assistant's, and keeps them; then lists them again. */
  save(
    assistant: string,
    extensions: SaveExtensionSetupsRequest["extensions"],
  ): Promise<ExtensionSetup[]>;
};

type Env = {
  Variables: {
    name: string;
    nudge: Nudge;
    credential: Credential;
  };
};

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

/** Entries read per storage page while a timeline page fills. */
const ENTRY_BATCH = 200;
/** Timeline items per page: default and most. */
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

/**
 * Protocol v1's HTTP commands, to mount at `/v1`: the assistant list, and per assistant under
 * `/a/<assistant>`, pairing, the caller's rooms, messages, memory, approvals, nudges, history and
 * the admin routes. Errors are `{ error }` with an HTTP status.
 */
export function restRoutes(options: RestOptions): Hono {
  const app = new Hono<Env>();

  app.get("/a", (c) =>
    c.json({
      assistants: [...options.assistants].map(([name, nudge]) => ({
        name,
        displayName: nudge.displayName,
      })),
    } satisfies AssistantsResponse),
  );

  const findAssistant: MiddlewareHandler<Env> = async (c, next) => {
    const name = c.req.param("assistant") ?? "";
    const nudge = options.assistants.get(name);
    if (nudge === undefined) throw new HttpError(404, `No assistant "${name}"`);
    c.set("name", name);
    c.set("nudge", nudge);
    await next();
  };

  const authenticate: MiddlewareHandler<Env> = async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const credential =
      token === undefined ? undefined : await c.var.nudge.players.authenticate(token, context);
    if (credential === undefined) throw new HttpError(401, "Missing or unknown token");
    c.set("credential", credential);
    await next();
  };

  const admin: MiddlewareHandler<Env> = async (c, next) => {
    if (!(await c.var.nudge.players.isAdmin(c.var.credential.player.id, context)))
      throw new HttpError(403, "Only admins may do that");
    await next();
  };

  const api = new Hono<Env>();
  api.use(findAssistant);

  // Before `authenticate`: a new client has no token yet.
  api.post("/pair", async (c) => {
    const body = await readBody(c, PairRequest);
    const paired = await c.var.nudge.players.pair(body.code, body.client, context);
    if (paired === undefined) throw new HttpError(401, "Unknown or expired pairing code");
    return c.json({
      token: paired.token,
      clientId: paired.clientId,
      player: toPlayer(paired.player),
    } satisfies PairResponse);
  });

  const pushes = (c: HonoContext<Env>): Pushes => {
    const found = options.pushesOf?.(c.var.nudge);
    if (found === undefined) throw new HttpError(404, "This server sends no pushes");
    return found;
  };

  // Also before it: a service worker has no token. The old subscription's auth secret stands in.
  api.post("/push/renew", async (c) => {
    const body = await readBody(c, PushRenewRequest);
    let renewed: boolean;
    try {
      renewed = await pushes(c).renew(body.old, body.subscription);
    } catch (error) {
      if (error instanceof BadSubscription) throw new HttpError(400, error.message);
      throw error;
    }
    if (!renewed) throw new HttpError(404, "No such subscription");
    return c.body(null, 204);
  });

  api.use(authenticate);

  api.get("/me", async (c) => {
    const { player, clientId } = c.var.credential;
    return c.json({
      player: toPlayer(player),
      clientId,
      admin: await c.var.nudge.players.isAdmin(player.id, context),
    } satisfies MeResponse);
  });

  // Signing out: the caller's own token stops working, and its sockets close with 4401.
  api.delete("/me/token", async (c) => {
    await c.var.nudge.players.revoke(c.var.credential.clientId, context);
    return c.body(null, 204);
  });

  api.get("/me/memory", async (c) => {
    const memory = await c.var.nudge.memory.ofPlayer(c.var.credential.player.id, context);
    return c.json({
      facts: memory.facts.map(toFact),
      shared: memory.shared,
    } satisfies PlayerMemoryResponse);
  });

  api.post("/me/memory", async (c) => {
    const body = await readBody(c, RememberRequest);
    if (body.text.trim() === "") throw new HttpError(400, "A fact needs text");
    const { player } = c.var.credential;
    const by = { playerId: player.id, displayName: player.displayName };
    try {
      return c.json(
        toFact(await c.var.nudge.memory.rememberFor(player.id, body.text, context, by)),
        201,
      );
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  api.delete("/me/memory/:fact", async (c) => {
    const id = c.req.param("fact");
    if (!(await c.var.nudge.memory.forgetFor(c.var.credential.player.id, id, context)))
      throw new HttpError(404, `No fact "${id}"`);
    return c.body(null, 204);
  });

  // Consent: everyone in the player's rooms, and the model there, then reads these facts.
  api.put("/me/memory/sharing", async (c) => {
    const body = await readBody(c, ShareMemoryRequest);
    const id = c.var.credential.player.id;
    await c.var.nudge.memory.share(id, body.shared, context);
    const memory = await c.var.nudge.memory.ofPlayer(id, context);
    return c.json({
      facts: memory.facts.map(toFact),
      shared: memory.shared,
    } satisfies PlayerMemoryResponse);
  });

  api.get("/usage", async (c) => {
    const { spending } = c.var.nudge;
    const { month, spend, budget } = spending.thisMonth();
    const me = c.var.credential.player.id;
    const admin = await c.var.nudge.players.isAdmin(me, context);
    return c.json({
      month,
      total: spend.total,
      mine: spend.players[me] ?? 0,
      budget: {
        ...(budget.monthlyUsd === undefined ? {} : { monthlyUsd: budget.monthlyUsd }),
        ...(budget.perPlayerUsd === undefined ? {} : { perPlayerUsd: budget.perPlayerUsd }),
      },
      ...(admin
        ? {
            months: spending.months().map(({ month, spend }) => ({
              month,
              total: spend.total,
              players: spend.players,
              rooms: spend.rooms,
            })),
          }
        : {}),
    } satisfies UsageResponse);
  });

  api.get("/push", (c) => c.json({ publicKey: pushes(c).publicKey } satisfies PushKeyResponse));

  api.post("/push", async (c) => {
    const body = await readBody(c, PushSubscribeRequest);
    const { player, clientId } = c.var.credential;
    try {
      await pushes(c).subscribe(player.id, clientId, body);
    } catch (error) {
      if (error instanceof BadSubscription) throw new HttpError(400, error.message);
      throw error;
    }
    return c.body(null, 204);
  });

  api.delete("/push", async (c) => {
    const endpoint = c.req.query("endpoint");
    if (endpoint === undefined) throw new HttpError(400, "Which endpoint? ?endpoint=…");
    if (!(await pushes(c).unsubscribe(c.var.credential.player.id, endpoint)))
      throw new HttpError(404, "No such subscription");
    return c.body(null, 204);
  });

  api.get("/devices", (c) => c.json(pushes(c).platforms satisfies DevicesResponse));

  api.post("/devices", async (c) => {
    const body = await readBody(c, DeviceRequest);
    const { player, clientId } = c.var.credential;
    try {
      await pushes(c).register(player.id, clientId, body);
    } catch (error) {
      if (error instanceof BadSubscription) throw new HttpError(400, error.message);
      throw error;
    }
    return c.body(null, 204);
  });

  api.delete("/devices/:token", async (c) => {
    if (!(await pushes(c).unregister(c.var.credential.player.id, c.req.param("token"))))
      throw new HttpError(404, "No such device");
    return c.body(null, 204);
  });

  api.post("/rooms", async (c) => {
    const body = await readBody(c, CreateRoomRequest);
    const name = body.name.trim();
    if (name === "") throw new HttpError(400, "A room needs a name");
    const me = c.var.credential.player.id;
    const members = [me, ...(body.members ?? []).filter((id) => id !== me)];
    let room: CoreRoom;
    try {
      room = await c.var.nudge.rooms.createShared({ name, members }, context);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return c.json(await roomOf(c.var.nudge, room), 201);
  });

  api.post("/rooms/personal", async (c) => {
    const room = await c.var.nudge.rooms.ensurePersonal(c.var.credential.player.id, context);
    return c.json(await roomOf(c.var.nudge, room));
  });

  api.post("/rooms/:room/messages", async (c) => {
    const room = await usableRoom(c);
    const body = await readBody(c, MessageRequest);
    if (body.text.trim() === "") throw new HttpError(400, "A message needs text");
    const { player, clientId } = c.var.credential;
    let submission;
    try {
      submission = await c.var.nudge.submit(
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
    } catch (error) {
      if (error instanceof BudgetReached) throw new HttpError(429, error.message);
      throw error;
    }
    return c.json({ submissionId: submission.id } satisfies MessageResponse, 202);
  });

  // What the privacy promise rests on, for anyone in the room to check.
  api.get("/rooms/:room/model-view", async (c) => {
    const room = await usableRoom(c);
    return c.json({
      messages: await c.var.nudge.modelView(room.id, context),
    } satisfies ModelViewResponse);
  });

  api.post("/rooms/:room/abort", async (c) => {
    const room = await usableRoom(c);
    await c.var.nudge.abort(room.id, context);
    return c.body(null, 204);
  });

  api.get("/rooms/:room/timeline", async (c) => {
    const room = await usableRoom(c);
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || PAGE_DEFAULT, 1), PAGE_MAX);
    const cursor = c.req.query("before");
    let before: number | undefined;
    if (cursor !== undefined) {
      const value = decodeCursor(cursor) as { before?: unknown } | undefined;
      if (typeof value?.before !== "number" || !Number.isInteger(value.before))
        throw new HttpError(400, "Bad cursor");
      before = value.before;
    } else {
      // Below what the room view shows; usually the caller has it open, so its hub is too.
      const lease = await options.hubsOf(c.var.nudge).room(room.id);
      if (lease === undefined) throw new HttpError(404, `No room "${room.id}"`);
      try {
        before = windowStart(lease.hub.conversationView());
      } finally {
        lease.release();
      }
    }
    if (before === undefined) return c.json({ items: [] } satisfies TimelineResponse);

    const conversation = await c.var.nudge.conversation(room.id, context);
    const pager = new TimelinePager(limit);
    let next: Cursor | undefined;
    read: do {
      const page = await conversation.entries(
        { maxEntryId: (before - 1) as EntryId },
        ENTRY_BATCH,
        next,
        context,
      );
      for (const entry of page.items) if (!pager.add(entry)) break read;
      next = page.next;
    } while (next !== undefined);
    const page = pager.page();
    return c.json({
      items: page.items,
      ...(page.before === undefined ? {} : { before: encodeCursor({ before: page.before }) }),
    } satisfies TimelineResponse);
  });

  api.post("/rooms/:room/memory", async (c) => {
    const room = await usableRoom(c);
    const body = await readBody(c, RememberRequest);
    if (body.text.trim() === "") throw new HttpError(400, "A fact needs text");
    try {
      const { player } = c.var.credential;
      const by = { playerId: player.id, displayName: player.displayName };
      return c.json(
        toFact(await c.var.nudge.memory.remember(room.id, body.text, context, by)),
        201,
      );
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  api.delete("/rooms/:room/memory/:fact", async (c) => {
    const room = await usableRoom(c);
    const id = c.req.param("fact");
    if (!(await c.var.nudge.memory.forget(room.id, id, context)))
      throw new HttpError(404, `No fact "${id}"`);
    return c.body(null, 204);
  });

  api.get("/rooms/:room/extensions", async (c) => {
    const room = await usableRoom(c);
    const extensions = await c.var.nudge.roomExtensions(room.id, context);
    return c.json({ extensions } satisfies RoomExtensionsResponse);
  });

  // Anyone in the room may change it, like its memory.
  api.put("/rooms/:room/extensions/:extension", async (c) => {
    const room = await usableRoom(c);
    const body = await readBody(c, SetRoomExtensionRequest);
    try {
      return c.json(
        await c.var.nudge.setRoomExtension(
          room.id,
          c.req.param("extension"),
          body.enabled ?? undefined,
          context,
        ),
      );
    } catch (error) {
      if (error instanceof ExtensionNotFound) throw new HttpError(404, error.message);
      throw error;
    }
  });

  api.post("/rooms/:room/approvals/:approval", async (c) => {
    const room = await usableRoom(c);
    const body = await readBody(c, DecideRequest);
    const { player } = c.var.credential;
    try {
      const approval = await c.var.nudge.approvals.decide(
        room.id,
        c.req.param("approval"),
        { approve: body.approve, by: { playerId: player.id, displayName: player.displayName } },
        context,
      );
      return c.json(toApproval(approval));
    } catch (error) {
      if (error instanceof ApprovalNotFound) throw new HttpError(404, error.message);
      if (error instanceof AlreadyDecided) throw new HttpError(409, error.message);
      throw error;
    }
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
    const body = await readBody(c, ProtectRequest);
    if (body.value.trim() === "") throw new HttpError(400, "Nothing to protect");
    const placeholder = await c.var.nudge.protect(body.value.trim(), body.kind);
    return c.json({ placeholder } satisfies ProtectResponse);
  });

  api.post("/admin/players", admin, async (c) => {
    const body = await readBody(c, CreatePlayerRequest);
    if (body.displayName.trim() === "") throw new HttpError(400, "A player needs a name");
    const player = await c.var.nudge.players.create(body.displayName, context);
    return c.json({ player: toPlayer(player) } satisfies PlayerResponse, 201);
  });

  api.get("/admin/players", admin, async (c) => {
    const nudge = c.var.nudge;
    const players = await Promise.all(
      (await nudge.players.list(context)).map((player) => adminPlayerOf(nudge, player)),
    );
    return c.json({ players } satisfies PlayersResponse);
  });

  // The first player stays an admin either way; the reply says so.
  api.put("/admin/players/:player/admin", admin, async (c) => {
    const body = await readBody(c, SetAdminRequest);
    const id = c.req.param("player");
    if ((await c.var.nudge.players.get(id, context)) === undefined)
      throw new HttpError(404, `No player "${id}"`);
    const player = await c.var.nudge.players.setAdmin(id, body.admin, context);
    return c.json(await adminPlayerOf(c.var.nudge, player));
  });

  api.post("/admin/tokens", admin, async (c) => {
    const body = await readBody(c, IssueTokenRequest);
    if ((await c.var.nudge.players.get(body.playerId, context)) === undefined)
      throw new HttpError(404, `No player "${body.playerId}"`);
    const issued = await c.var.nudge.players.issueToken(body.playerId, context);
    return c.json(
      {
        token: issued.token,
        clientId: issued.clientId,
        player: toPlayer(issued.player),
      } satisfies PairResponse,
      201,
    );
  });

  api.get("/admin/rooms", admin, async (c) => {
    const nudge = c.var.nudge;
    const players = new Map((await nudge.players.list(context)).map((p) => [p.id, p]));
    const rooms = (await nudge.rooms.list(context)).map((room) =>
      toRoom(room, (id) => players.get(id)),
    );
    return c.json({ rooms } satisfies RoomsResponse);
  });

  api.post("/admin/rooms", admin, async (c) => {
    const body = await readBody(c, AdminCreateRoomRequest);
    const name = body.name.trim();
    if (name === "") throw new HttpError(400, "A room needs a name");
    if (body.members.length === 0) throw new HttpError(400, "A room needs members");
    let room: CoreRoom;
    try {
      room = await c.var.nudge.rooms.createShared({ name, members: body.members }, context);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return c.json(await roomOf(c.var.nudge, room), 201);
  });

  api.get("/admin/nudges", admin, async (c) => {
    const pending = await c.var.nudge.nudges.list(context);
    return c.json({ nudges: pending.map(toHomeNudge) } satisfies NudgesResponse);
  });

  api.post("/admin/pairing-codes", admin, async (c) => {
    const body = await readBody(c, PairingCodeRequest);
    if ((await c.var.nudge.players.get(body.playerId, context)) === undefined)
      throw new HttpError(404, `No player "${body.playerId}"`);
    const { code, expiresAt } = await c.var.nudge.players.pairingCode(body.playerId, context);
    const server = options.publicUrl ?? new URL(c.req.url).origin;
    return c.json(
      {
        code,
        link: pairingLink(server, c.var.name, code),
        expiresAt,
      } satisfies PairingCodeResponse,
      201,
    );
  });

  api.get("/admin/tokens", admin, async (c) => {
    const playerId = c.req.query("player") || undefined;
    if (playerId !== undefined && (await c.var.nudge.players.get(playerId, context)) === undefined)
      throw new HttpError(404, `No player "${playerId}"`);
    const records = await c.var.nudge.players.tokens(playerId, context);
    return c.json({ tokens: records.map(toTokenInfo) } satisfies TokensResponse);
  });

  // Sockets signed in with the token close with 4401: each connection watches the directory.
  api.delete("/admin/tokens/:client", admin, async (c) => {
    const clientId = c.req.param("client");
    const known = await c.var.nudge.players.tokens(undefined, context);
    if (!known.some((record) => record.clientId === clientId))
      throw new HttpError(404, `No token for client "${clientId}"`);
    await c.var.nudge.players.revoke(clientId, context);
    return c.body(null, 204);
  });

  const extensionSettings = (): ExtensionSettings => {
    if (options.extensionSettings === undefined)
      throw new HttpError(404, "This server can't set up extensions");
    return options.extensionSettings;
  };

  api.get("/admin/extensions", admin, async (c) => {
    const extensions = await asBadRequest(() => extensionSettings().list(c.var.name));
    return c.json({ extensions } satisfies ExtensionSetupsResponse);
  });

  // Reinstalls the extensions now, and writes the config only once that worked.
  api.put("/admin/extensions", admin, async (c) => {
    const body = await readBody(c, SaveExtensionSetupsRequest);
    const extensions = await asBadRequest(() =>
      extensionSettings().save(c.var.name, body.extensions),
    );
    return c.json({ extensions } satisfies ExtensionSetupsResponse);
  });

  app.route("/a/:assistant", api);
  return app as unknown as Hono;
}

async function asBadRequest<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConfigError) throw new HttpError(400, error.message);
    throw error;
  }
}

/** `nudge://pair?server=…&assistant=…&code=…`, what a pairing QR code holds. */
export function pairingLink(server: string, assistant: string, code: string): string {
  const query = new URLSearchParams({ server, assistant, code });
  return `nudge://pair?${query.toString()}`;
}

/** The room in the path, if the caller may use it. Rooms they may not use do not exist for them. */
async function usableRoom(c: HonoContext<Env>): Promise<CoreRoom> {
  const id = c.req.param("room") ?? "";
  const room = await c.var.nudge.rooms.get(id, context);
  if (room === undefined || !canUse(room, c.var.credential.player.id))
    throw new HttpError(404, `No room "${id}"`);
  return room;
}

async function roomOf(nudge: Nudge, room: CoreRoom): Promise<Room> {
  const members = new Map(
    (await nudge.rooms.members(room.id, context)).map((player) => [player.id, player]),
  );
  return toRoom(room, (id) => members.get(id));
}

async function adminPlayerOf(nudge: Nudge, player: CorePlayer): Promise<AdminPlayer> {
  return { ...toPlayer(player), admin: await nudge.players.isAdmin(player.id, context) };
}

function toTokenInfo(record: TokenRecord): TokenInfo {
  return {
    clientId: record.clientId,
    playerId: record.playerId,
    createdAt: record.createdAt,
    ...(record.client === undefined ? {} : { client: record.client }),
  };
}

/** The JSON body, checked against `schema`; a 400 naming the first problem otherwise. */
async function readBody<S extends TSchema>(c: HonoContext<Env>, schema: S): Promise<Static<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
  if (Value.Check(schema, body)) return body;
  const [first] = Value.Errors(schema, body);
  throw new HttpError(
    400,
    first === undefined ? "Bad body" : `${first.instancePath || "body"} ${first.message}`,
  );
}
