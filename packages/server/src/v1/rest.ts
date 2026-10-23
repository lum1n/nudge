import type { Cursor, EntryId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  addressOf,
  AdminOnly,
  AlreadyDecided,
  ApprovalNotFound,
  BudgetReached,
  canUse,
  ConfigError,
  type Credential,
  ExtensionBroken,
  ExtensionNotFound,
  InvalidAppearance,
  InvalidPersonal,
  InvalidProfile,
  MAX_ROUTE_BODY,
  NotAllowed,
  type Nudge,
  type Player as CorePlayer,
  type PersonalUpdate,
  type ProfileUpdate,
  type Room as CoreRoom,
  type TokenRecord,
} from "@nudge/core";
import {
  AdminCreateRoomRequest,
  type AdminPlayer,
  type AppearanceResponse,
  type AssistantsResponse,
  CreatePlayerRequest,
  CreateRoomRequest,
  DecideRequest,
  decodeCursor,
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
  type SignInResponse,
  type PlayerMemoryResponse,
  type PlayerResponse,
  type PlayersResponse,
  ProtectRequest,
  type PrivateValuesResponse,
  type PlayerSettingsResponse,
  type PersonalDetails,
  type Profile,
  type ProtectResponse,
  RememberRequest,
  RenameRoomRequest,
  SaveExtensionSetupsRequest,
  type Room,
  type RoomExtensionsResponse,
  type RoomsResponse,
  SetAdminRequest,
  SetAppearanceRequest,
  ShareLocationRequest,
  ShareMemoryRequest,
  SetRoomExtensionRequest,
  type TimelineResponse,
  type TokenInfo,
  type TokensResponse,
  UpdatePersonalRequest,
  UpdateProfileRequest,
  type UsageResponse,
} from "@nudge/protocol";
import {
  TimelinePager,
  toApproval,
  toFact,
  toRoomListNudge,
  toPlayer,
  toRoom,
  windowStart,
} from "@nudge/protocol/project";
import { type Context as HonoContext, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Hubs } from "./hub.ts";
import { SignInRequests, signInLink } from "./sign-in.ts";

const context = BACKGROUND_CONTEXT;

export type RestOptions = {
  readonly assistants: ReadonlyMap<string, Nudge>;
  readonly hubsOf: (nudge: Nudge) => Hubs;
  /** The server's address as clients reach it, for pairing links; default the request's origin. */
  readonly publicUrl: () => string | undefined;
  /** Whether the request's origin is the one a proxy in front says (`X-Forwarded-*`). */
  readonly trustProxy: () => boolean;
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
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 502,
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

  app.get("/a", async (c) =>
    c.json({
      assistants: await Promise.all(
        [...options.assistants].map(async ([name, nudge]) => {
          const appearance = await nudge.appearance.get(context);
          return {
            name,
            displayName: nudge.displayName,
            ...(appearance === undefined ? {} : { appearance }),
          };
        }),
      ),
    } satisfies AssistantsResponse),
  );

  // The web UI's sign-in by QR code: the browser starts and asks without a token, an app that is
  // signed in to one of the assistants approves.
  const signIns = new SignInRequests();

  app.post("/sign-in", (c) => {
    const started = signIns.start();
    if (started === undefined)
      throw new HttpError(429, "Too many sign-ins waiting; try again soon");
    const server = options.publicUrl() ?? requestOrigin(c.req.raw, options.trustProxy());
    return c.json(
      { ...started, link: signInLink(server, started.id) } satisfies SignInResponse,
      201,
    );
  });

  app.get("/sign-in/:id", (c) => {
    const secret = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const status = secret === undefined ? undefined : signIns.status(c.req.param("id"), secret);
    if (status === undefined) throw new HttpError(404, "No such sign-in, or it expired");
    return c.json(status);
  });

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

  /** What the caller may see of what a route answers. */
  const viewerOf = (c: HonoContext<Env>) =>
    options.hubsOf(c.var.nudge).viewer(c.var.credential.player.id);

  // Before `authenticate`: a new client has no token yet.
  api.post("/pair", async (c) => {
    const body = await readJson(c, PairRequest);
    const paired = await c.var.nudge.players.pair(body.code, body.client, context);
    if (paired === undefined) throw new HttpError(401, "Unknown or expired pairing code");
    return c.json({
      token: paired.token,
      clientId: paired.clientId,
      player: toPlayer(paired.player),
    } satisfies PairResponse);
  });

  // Also before it: each route says whether it needs a token.
  const extensionRoute = async (c: HonoContext<Env>) => {
    const name = c.req.param("extension") ?? "";
    const prefix = `/ext/${name}`;
    const path = c.req.path.slice(c.req.path.indexOf(prefix) + prefix.length) || "/";
    const found = c.var.nudge.extensionRoute(name, c.req.method, path);
    if (found === undefined) throw new HttpError(404, "Not found");
    const { route, params } = found;
    let player: CorePlayer | undefined;
    let clientId: string | undefined;
    let isAdmin = false;
    if (route.auth !== "none") {
      await authenticate(c, async () => {});
      player = c.var.credential.player;
      clientId = c.var.credential.clientId;
      isAdmin = await c.var.nudge.players.isAdmin(player.id, context);
      if (route.auth === "admin" && !isAdmin) throw new HttpError(403, "Only admins may do that");
    }
    let response: Response | undefined;
    const maxSize = route.maxBodyBytes ?? MAX_ROUTE_BODY;
    await bodyLimit({
      maxSize,
      onError: () => {
        throw new HttpError(413, `The body is over ${maxSize} bytes`);
      },
    })(c, async () => {
      response = await route.handle(c.req.raw, {
        ...(player === undefined ? {} : { player, clientId }),
        admin: isAdmin,
        params,
        context,
      });
    });
    return response!;
  };
  api.all("/ext/:extension", extensionRoute);
  api.all("/ext/:extension/*", extensionRoute);

  api.use(authenticate);

  // Signs in the browser that shows the QR code as the caller, with a pairing code it trades.
  api.post("/sign-in/:id", async (c) => {
    const id = c.req.param("id");
    if (!signIns.pending(id))
      throw new HttpError(404, "That QR code expired or was used; show a new one");
    const { code } = await c.var.nudge.players.pairingCode(c.var.credential.player.id, context);
    if (!signIns.approve(id, c.var.name, code))
      throw new HttpError(409, "That QR code was used meanwhile");
    return c.body(null, 204);
  });

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
    return c.json(
      viewerOf(c).strings({
        facts: memory.facts.map(toFact),
        shared: memory.shared,
      } satisfies PlayerMemoryResponse),
    );
  });

  api.post("/me/memory", async (c) => {
    const body = await readJson(c, RememberRequest);
    if (body.text.trim() === "") throw new HttpError(400, "A fact needs text");
    const { player } = c.var.credential;
    const by = { playerId: player.id, displayName: player.displayName };
    try {
      return c.json(
        viewerOf(c).strings(
          toFact(await c.var.nudge.memory.rememberFor(player.id, body.text, context, by)),
        ),
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
    const body = await readJson(c, ShareMemoryRequest);
    const id = c.var.credential.player.id;
    await c.var.nudge.memory.share(id, body.shared, context);
    const memory = await c.var.nudge.memory.ofPlayer(id, context);
    return c.json(
      viewerOf(c).strings({
        facts: memory.facts.map(toFact),
        shared: memory.shared,
      } satisfies PlayerMemoryResponse),
    );
  });

  api.get("/me/profile", async (c) => {
    const profile = await c.var.nudge.profiles.get(c.var.credential.player.id, context);
    if (profile === undefined) throw new HttpError(404, "No such player");
    return c.json(profile satisfies Profile);
  });

  api.get("/me/profile/extensions", (c) =>
    c.json({
      // Through JSON: TypeBox keeps its own markers on symbols, which clients have no use for.
      extensions: c.var.nudge.playerSettings().map((extension) => ({
        ...extension,
        schema: JSON.parse(JSON.stringify(extension.schema)),
      })),
    } satisfies PlayerSettingsResponse),
  );

  api.patch("/me/profile", async (c) => {
    // Their home sends it, and would undo a change made here with the next.
    const { home } = c.var.credential.player;
    if (home !== undefined)
      throw new HttpError(403, `Your profile comes from your home, ${addressOf(home)}`);
    const body = await readJson(c, UpdateProfileRequest);
    try {
      const profile = await c.var.nudge.profiles.update(
        c.var.credential.player.id,
        body as ProfileUpdate,
        context,
      );
      return c.json(profile satisfies Profile);
    } catch (error) {
      if (error instanceof InvalidProfile) throw new HttpError(400, error.message);
      throw error;
    }
  });

  api.get("/me/personal", async (c) => {
    const details = await c.var.nudge.personal.get(c.var.credential.player.id, context);
    if (details === undefined) throw new HttpError(404, "No such player");
    return c.json(details satisfies PersonalDetails);
  });

  api.patch("/me/personal", async (c) => {
    // Kept where the player lives, and not spread to the assistants they joined.
    const { home } = c.var.credential.player;
    if (home !== undefined)
      throw new HttpError(403, `Your personal details stay at your home, ${addressOf(home)}`);
    const body = await readJson(c, UpdatePersonalRequest);
    try {
      const details = await c.var.nudge.personal.update(
        c.var.credential.player.id,
        body as PersonalUpdate,
        context,
      );
      return c.json(details satisfies PersonalDetails);
    } catch (error) {
      if (error instanceof InvalidPersonal) throw new HttpError(400, error.message);
      throw error;
    }
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

  api.post("/rooms", async (c) => {
    const body = await readJson(c, CreateRoomRequest);
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

  // Members rename their rooms; admins any room, the lobby too.
  api.patch("/rooms/:room", async (c) => {
    const id = c.req.param("room");
    const me = c.var.credential.player.id;
    const found = await c.var.nudge.rooms.get(id, context);
    if (
      found === undefined ||
      (!canUse(found, me) && !(await c.var.nudge.players.isAdmin(me, context)))
    )
      throw new HttpError(404, `No room "${id}"`);
    const body = await readJson(c, RenameRoomRequest);
    if (body.name.trim() === "") throw new HttpError(400, "A room needs a name");
    try {
      const room = await c.var.nudge.renameRoom(id, body.name, context, { playerId: me });
      return c.json(await roomOf(c.var.nudge, room));
    } catch (error) {
      if (error instanceof NotAllowed) throw new HttpError(403, error.message);
      throw error;
    }
  });

  api.post("/rooms/:room/messages", async (c) => {
    const room = await usableRoom(c);
    const body = await readJson(c, MessageRequest);
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
          ...(body.private === true ? { private: true } : {}),
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
      messages: await c.var.nudge.modelView(room.id, context, c.var.credential.player.id),
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
      items: viewerOf(c).timeline(page.items),
      ...(page.before === undefined ? {} : { before: encodeCursor({ before: page.before }) }),
    } satisfies TimelineResponse);
  });

  api.post("/rooms/:room/memory", async (c) => {
    const room = await usableRoom(c);
    const body = await readJson(c, RememberRequest);
    if (body.text.trim() === "") throw new HttpError(400, "A fact needs text");
    try {
      const { player } = c.var.credential;
      const by = { playerId: player.id, displayName: player.displayName };
      return c.json(
        viewerOf(c).strings(
          toFact(await c.var.nudge.memory.remember(room.id, body.text, context, by)),
        ),
        201,
      );
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  api.delete("/rooms/:room/memory/:fact", async (c) => {
    const room = await usableRoom(c);
    const id = c.req.param("fact");
    if (
      !(await c.var.nudge.memory.forget(room.id, id, context, {
        playerId: c.var.credential.player.id,
      }))
    )
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
    const body = await readJson(c, SetRoomExtensionRequest);
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
      if (error instanceof ExtensionBroken) throw new HttpError(409, error.message);
      throw error;
    }
  });

  // Consent: the model there may then know where the caller is, for anyone in the room.
  api.put("/rooms/:room/location", async (c) => {
    const room = await usableRoom(c);
    const { player } = c.var.credential;
    if (player.home !== undefined)
      throw new HttpError(403, `Where you are stays at your home, ${addressOf(player.home)}`);
    const body = await readJson(c, ShareLocationRequest);
    try {
      const details = await c.var.nudge.personal.shareLocation(
        player.id,
        room.id,
        body.shared,
        context,
      );
      return c.json(details satisfies PersonalDetails);
    } catch (error) {
      if (error instanceof InvalidPersonal) throw new HttpError(400, error.message);
      throw error;
    }
  });

  api.post("/rooms/:room/approvals/:approval", async (c) => {
    const room = await usableRoom(c);
    const body = await readJson(c, DecideRequest);
    const { player } = c.var.credential;
    try {
      const approval = await c.var.nudge.approvals.decide(
        room.id,
        c.req.param("approval"),
        { approve: body.approve, by: { playerId: player.id, displayName: player.displayName } },
        context,
      );
      return c.json(viewerOf(c).strings(toApproval(approval)));
    } catch (error) {
      if (error instanceof ApprovalNotFound) throw new HttpError(404, error.message);
      if (error instanceof AlreadyDecided) throw new HttpError(409, error.message);
      if (error instanceof AdminOnly) throw new HttpError(403, error.message);
      throw error;
    }
  });

  api.delete("/nudges/:id", async (c) => {
    const id = c.req.param("id");
    const nudge = await c.var.nudge.nudges.get(id, context);
    const room =
      nudge === undefined ? undefined : await c.var.nudge.rooms.get(nudge.roomId, context);
    const playerId = c.var.credential.player.id;
    if (
      room === undefined ||
      !canUse(room, playerId) ||
      (nudge?.privateTo !== undefined && nudge.privateTo.playerId !== playerId)
    )
      throw new HttpError(404, `No nudge "${id}"`);
    await c.var.nudge.nudges.cancel(id, context);
    return c.body(null, 204);
  });

  api.post("/protect", async (c) => {
    const body = await readJson(c, ProtectRequest);
    if (body.value.trim() === "") throw new HttpError(400, "Nothing to protect");
    const placeholder = await c.var.nudge.protect(
      body.value.trim(),
      body.kind,
      body.private === true ? { owner: c.var.credential.player.id } : {},
    );
    return c.json({ placeholder } satisfies ProtectResponse);
  });

  api.get("/me/private", (c) =>
    c.json({
      values: c.var.nudge.privateValues(c.var.credential.player.id),
    } satisfies PrivateValuesResponse),
  );

  // Its owner may forget a private value; any other value needs an admin, since it may show in
  // rooms the caller isn't in.
  api.delete("/vault/:placeholder", async (c) => {
    const placeholder = c.req.param("placeholder");
    const { player } = c.var.credential;
    try {
      const forgotten = await c.var.nudge.forgetValue(placeholder, {
        playerId: player.id,
        admin: await c.var.nudge.players.isAdmin(player.id, context),
      });
      if (!forgotten) throw new HttpError(404, `No value ${placeholder}`);
    } catch (error) {
      if (error instanceof NotAllowed) throw new HttpError(403, error.message);
      throw error;
    }
    return c.body(null, 204);
  });

  api.post("/admin/players", admin, async (c) => {
    const body = await readJson(c, CreatePlayerRequest);
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
    const body = await readJson(c, SetAdminRequest);
    const id = c.req.param("player");
    if ((await c.var.nudge.players.get(id, context)) === undefined)
      throw new HttpError(404, `No player "${id}"`);
    const player = await c.var.nudge.players.setAdmin(id, body.admin, context);
    return c.json(await adminPlayerOf(c.var.nudge, player));
  });

  // Room lists show the change as it happens; `null` goes back to the app icon's robot.
  api.put("/admin/appearance", admin, async (c) => {
    const body = await readJson(c, SetAppearanceRequest);
    try {
      const appearance = await c.var.nudge.appearance.set(body.appearance, context);
      return c.json((appearance === undefined ? {} : { appearance }) satisfies AppearanceResponse);
    } catch (error) {
      if (error instanceof InvalidAppearance) throw new HttpError(400, error.message);
      throw error;
    }
  });

  api.post("/admin/tokens", admin, async (c) => {
    const body = await readJson(c, IssueTokenRequest);
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
    const body = await readJson(c, AdminCreateRoomRequest);
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
    // Admins see that others' private nudges exist, not what they say.
    const viewer = viewerOf(c);
    return c.json({
      nudges: pending.map((nudge) => {
        const shown = viewer.strings(toRoomListNudge(nudge));
        return viewer.sees(shown.privateTo) ? shown : { ...shown, message: "" };
      }),
    } satisfies NudgesResponse);
  });

  api.post("/admin/pairing-codes", admin, async (c) => {
    const body = await readJson(c, PairingCodeRequest);
    if ((await c.var.nudge.players.get(body.playerId, context)) === undefined)
      throw new HttpError(404, `No player "${body.playerId}"`);
    const { code, expiresAt } = await c.var.nudge.players.pairingCode(body.playerId, context);
    const server = options.publicUrl() ?? requestOrigin(c.req.raw, options.trustProxy());
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
    const body = await readJson(c, SaveExtensionSetupsRequest);
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
/** The request's JSON body, checked against `schema`; a 400 naming the first problem otherwise. */
export async function readJson<S extends TSchema>(
  // oxlint-disable-next-line no-explicit-any -- any route's context; only the body is read
  c: HonoContext<any>,
  schema: S,
): Promise<Static<S>> {
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

/**
 * Where the client reached the server: the request's own origin, or behind a proxy that ends TLS,
 * such as exe.dev's, the one its `X-Forwarded-Proto` and `X-Forwarded-Host` name. Only trusted when
 * the server is told to, since anyone can send those headers to a server reached directly.
 */
export function requestOrigin(request: Request, trustProxy: boolean): string {
  const own = new URL(request.url);
  if (!trustProxy) return own.origin;
  const first = (name: string) => request.headers.get(name)?.split(",")[0]?.trim() || undefined;
  const proto = first("x-forwarded-proto");
  const host = first("x-forwarded-host");
  const protocol = proto === "https" || proto === "http" ? proto : own.protocol.slice(0, -1);
  return `${protocol}://${host ?? own.host}`;
}
