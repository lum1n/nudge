import {
  addressOf,
  type AssistantConfig,
  AssistantExists,
  AssistantNotFound,
  type Assistants,
  BACKGROUND_CONTEXT,
  BackupError,
  ConfigError,
  DEFAULT_MODEL,
  defaultExtensions,
  fetchKeys,
  GeoUnavailable,
  LastOwner,
  type ModelErrors,
  type Nudge,
  type NudgeConfig,
  ownerFromHome,
  parseAddress,
  type PlayerHome,
  sealRecoveryKit,
  type ServerIdentity,
  type ServerKeys,
  type ServerOwner,
  type ServerOwners,
  WiredError,
} from "@nudge/core";
import {
  AddOwnerRequest,
  type BackupNowResponse,
  type BackupState,
  type CreateAssistantResponse,
  CreateAssistantRequest,
  type DeleteAssistantResponse,
  InviteToAssistantRequest,
  type InviteToAssistantResponse,
  type ProviderKey,
  type ProviderKeysResponse,
  RecoveryKitRequest,
  type RecoveryKitResponse,
  type ServerAssistant,
  type ServerAssistantsResponse,
  type ServerInfoResponse,
  type ServerOwner as ShownOwner,
  type ServerKeyResponse,
  type ServerOwnersResponse,
  ServerSessionRequest,
  type ServerSessionResponse,
  SetBackupRemoteRequest,
  SetProviderKeyRequest,
  SetGeoRequest,
  SetUpdatesRequest,
  WiredEnableRequest,
  WiredJoinRequest,
  WiredRelayRequest,
  type WiredRelayResponse,
  type WiredState,
  type GeoRegionsResponse,
  type GeoStatus,
  type UpdateState,
  UpdateAssistantRequest,
} from "@nudge/protocol";
import { type Context as HonoContext, Hono, type MiddlewareHandler } from "hono";
import { HttpError, pairingLink, readJson, requestOrigin } from "./rest.ts";

const context = BACKGROUND_CONTEXT;

/** Providers every key list names, so an owner sees where to put the first key. */
const WELL_KNOWN = ["anthropic", "openai"];

/** What the server API runs on: the server's assistants, keys and owners. */
export type ServerControl = {
  readonly assistants: Assistants;
  readonly keys: ServerKeys;
  readonly owners: ServerOwners;
  /** The server's own keys, that owners' homes vouch for them to. */
  readonly identity: ServerIdentity;
  /** How the server reaches owners' homes for their keys; default the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Backs up the assistant `config` holds before it is deleted; returns the backup's name. */
  backupBeforeDelete(config: NudgeConfig): Promise<string>;
  /** Sends one tiny request with the key, throwing with the provider's answer when it fails. */
  testKey(provider: string, key: string): Promise<void>;
  /** The key the server's backups are encrypted with, for the recovery kit. */
  backupKey(): Promise<Buffer>;
  /** Self-update, for a server `nudge-server` runs; absent otherwise. */
  readonly updates?: UpdateControl;
  /** The server's own map (ADR 18); absent where the server wasn't given one. */
  readonly geo?: GeoControl;
  /** The server's Wired; absent where the server wasn't given one. */
  readonly wired?: WiredControl;
  /** The server's own backups and where they are copied; absent where it doesn't make them. */
  readonly backups?: BackupControl;
};

/** What owners see of and do with the server's backups (ADR 8). */
export type BackupControl = {
  state(): Promise<BackupState>;
  /** Checks the target can be written (unless `test` is false), then keeps it; turns backups on. */
  setRemote(change: SetBackupRemoteRequest): Promise<BackupState>;
  /** Stops copying backups off the server, and forgets its credentials. */
  removeRemote(): Promise<BackupState>;
  /** Makes a backup now, and uploads it where backups are copied. */
  backUpNow(): Promise<BackupNowResponse>;
};

/** What owners see of and do with the server's Wired. */
export type WiredControl = {
  state(): WiredState;
  /** Makes this server the network's root, as `name` when given. */
  enable(name?: string): Promise<WiredState>;
  /** On the root: lists a new server's relay and answers with the invite it joins with. */
  addRelay(url: string): Promise<string>;
  /**
   * Joins the network an invite is for, as `name` when given, serving a relay at the public
   * address or `relayUrl`.
   */
  join(invite: string, options: { name?: string; relayUrl?: string }): Promise<WiredState>;
  /** On the root: removes a server from the network, freeing its name. */
  remove(name: string): Promise<WiredState>;
  /** Leaves the network, or stops holding it, and forgets it. */
  disable(): Promise<WiredState>;
};

/** What owners see of and do with the server's map. */
export type GeoControl = {
  status(): GeoStatus;
  available(): Promise<GeoRegionsResponse["regions"]>;
  configure(change: SetGeoRequest): Promise<GeoStatus>;
};

/** What owners see of and do with updates. */
export type UpdateControl = {
  state(): UpdateState;
  /** Looks for a newer release now; installs it when updates are automatic. */
  check(): Promise<UpdateState>;
  setAutomatic(automatic: boolean): Promise<UpdateState>;
};

export type ServerRoutesOptions = {
  readonly control: ServerControl;
  readonly version: string;
  readonly publicUrl: () => string | undefined;
  readonly trustProxy: () => boolean;
  /** The host's last model errors, shown to owners; none without. */
  readonly modelErrors?: Pick<ModelErrors, "recent">;
};

type Env = { Variables: { owner: ServerOwner; clientId: string } };

/**
 * The server's own API (ADR 11), to mount at `/v1/server`: for its owners, with a server token,
 * to create, change and delete assistants and to set the model keys. An owner who lives on one of
 * its assistants trades their player token for a server token at `POST /session`; one whose home
 * is elsewhere trades an assertion from it, sealed for the server's own keys at `GET /key`.
 */
export function serverRoutes(options: ServerRoutesOptions): Hono<Env> {
  const { control } = options;
  const app = new Hono<Env>();

  app.get("/key", (c) => c.json(control.identity.publicKeys() satisfies ServerKeyResponse));

  app.post("/session", async (c) => {
    const body = await readJson(c, ServerSessionRequest);
    let owner: ServerOwner | undefined;
    if (body.assertion !== undefined) {
      // Their home vouching for them, to this server itself.
      const signedIn = await ownerFromHome(body.assertion, {
        identity: control.identity,
        owners: control.owners,
        fetch: control.fetch ?? fetch,
      });
      if (!("owner" in signedIn)) throw new HttpError(signedIn.status, signedIn.error);
      owner = signedIn.owner;
    } else {
      // The token of their player on the assistant they live on.
      const nudge =
        body.assistant === undefined ? undefined : control.assistants.running.get(body.assistant);
      const token = bearer(c);
      const credential =
        nudge === undefined || token === undefined
          ? undefined
          : await nudge.players.authenticate(token, context);
      if (credential === undefined) throw new HttpError(401, "Missing or unknown token");
      const { player } = credential;
      owner =
        player.home === undefined
          ? control.owners.ownerOf(body.assistant!, player.id)
          : control.owners.ownerAt(player.home);
      if (owner === undefined) throw new HttpError(403, "Only the server's owners may do that");
    }
    const issued = control.owners.issue(owner.id, body.client);
    return c.json({ ...issued, owner: shownOwner(owner) } satisfies ServerSessionResponse, 201);
  });

  const authenticate: MiddlewareHandler<Env> = async (c, next) => {
    const token = bearer(c);
    const signedIn = token === undefined ? undefined : control.owners.authenticate(token);
    if (signedIn === undefined) throw new HttpError(401, "Missing or unknown server token");
    c.set("owner", signedIn.owner);
    c.set("clientId", signedIn.clientId);
    await next();
  };
  app.use(authenticate);

  app.get("/", async (c) =>
    c.json({
      version: options.version,
      owner: shownOwner(c.var.owner),
      assistants: await listAssistants(control),
      ...(control.updates === undefined ? {} : { updates: control.updates.state() }),
      ...(options.modelErrors === undefined
        ? {}
        : {
            errors: options.modelErrors.recent().map((error) => ({
              at: error.at,
              ...(error.assistant === undefined ? {} : { assistant: error.assistant }),
              provider: error.provider,
              model: error.model,
              message: error.message,
            })),
          }),
    } satisfies ServerInfoResponse),
  );

  const updates = () => {
    if (control.updates === undefined)
      throw new HttpError(
        404,
        "This server doesn't update itself: it wasn't started by nudge-server",
      );
    return control.updates;
  };

  app.post("/updates/check", async (c) => c.json(await updates().check()));

  app.put("/updates", async (c) => {
    const { automatic } = await readJson(c, SetUpdatesRequest);
    return c.json(await updates().setAutomatic(automatic));
  });

  const geo = () => {
    if (control.geo === undefined) throw new HttpError(404, "This server has no map");
    return control.geo;
  };

  app.get("/geo", (c) => c.json(geo().status() satisfies GeoStatus));

  app.get("/geo/regions", async (c) =>
    c.json({ regions: await guard(() => geo().available()) } satisfies GeoRegionsResponse),
  );

  app.put("/geo", async (c) => {
    const change = await readJson(c, SetGeoRequest);
    return c.json((await guard(() => geo().configure(change))) satisfies GeoStatus);
  });

  const wired = () => {
    if (control.wired === undefined) throw new HttpError(404, "This server has no Wired");
    return control.wired;
  };

  app.get("/wired", (c) => c.json(wired().state() satisfies WiredState));

  app.post("/wired", async (c) => {
    // A body is optional: without one, the server takes its usual name.
    const { name } = c.req.header("content-type")?.includes("json")
      ? await readJson(c, WiredEnableRequest)
      : {};
    return c.json((await guard(() => wired().enable(name))) satisfies WiredState);
  });

  app.delete("/wired", async (c) => c.json((await wired().disable()) satisfies WiredState));

  app.post("/wired/join", async (c) => {
    const { invite, relayUrl, name } = await readJson(c, WiredJoinRequest);
    const options = {
      ...(name === undefined ? {} : { name }),
      ...(relayUrl === undefined ? {} : { relayUrl }),
    };
    return c.json((await guard(() => wired().join(invite, options))) satisfies WiredState);
  });

  app.post("/wired/relays", async (c) => {
    const { url } = await readJson(c, WiredRelayRequest);
    const invite = await guard(() => wired().addRelay(url));
    return c.json({ invite } satisfies WiredRelayResponse);
  });

  app.delete("/wired/members/:name", async (c) =>
    c.json((await guard(() => wired().remove(c.req.param("name")))) satisfies WiredState),
  );

  app.delete("/session", (c) => {
    control.owners.revoke(c.var.clientId);
    return c.body(null, 204);
  });

  app.get("/assistants", async (c) =>
    c.json({ assistants: await listAssistants(control) } satisfies ServerAssistantsResponse),
  );

  app.post("/assistants", async (c) => {
    const { firstPlayer, invite, ...draft } = await readJson(c, CreateAssistantRequest);
    const extensions = defaultExtensions(control.assistants.configPath, options.publicUrl());
    if (invite !== undefined && !extensions.some((e) => e.from.endsWith("federation")))
      throw new HttpError(
        400,
        "Inviting someone needs federation, and this server has no public address for it",
      );
    const nudge = await guard(() => control.assistants.create({ ...draft, extensions }));
    let joinLink: string | undefined;
    if (invite !== undefined) {
      try {
        joinLink = await inviteTo(nudge, invite);
      } catch (error) {
        throw new HttpError(
          400,
          `Made ${draft.name}, but couldn't invite ${invite}: ${(error as Error).message}`,
        );
      }
    }
    let pairing: CreateAssistantResponse["pairing"];
    if (firstPlayer !== undefined) {
      // The first player is its admin for good.
      const player = await nudge.players.create(firstPlayer.displayName, context);
      const { code, expiresAt } = await nudge.players.pairingCode(player.id, context);
      const server = options.publicUrl() ?? requestOrigin(c.req.raw, options.trustProxy());
      pairing = {
        code,
        link: pairingLink(server, draft.name, code),
        expiresAt,
        playerId: player.id,
      };
    }
    const assistant = (await listAssistants(control)).find((a) => a.name === draft.name)!;
    return c.json(
      {
        assistant,
        ...(pairing === undefined ? {} : { pairing }),
        ...(joinLink === undefined ? {} : { joinLink }),
      } satisfies CreateAssistantResponse,
      201,
    );
  });

  app.post("/assistants/:name/invites", async (c) => {
    const name = c.req.param("name");
    const { address } = await readJson(c, InviteToAssistantRequest);
    const nudge = control.assistants.running.get(name);
    if (nudge === undefined) throw new HttpError(404, `No assistant "${name}"`);
    if (nudge.extensionRoute("federation", "POST", "/invites") === undefined)
      throw new HttpError(400, `${name} has no federation, so no one can join it from home`);
    let joinLink: string;
    try {
      joinLink = await inviteTo(nudge, address);
    } catch (error) {
      throw new HttpError(400, `Couldn't invite ${address}: ${(error as Error).message}`);
    }
    return c.json({ joinLink } satisfies InviteToAssistantResponse, 201);
  });

  app.patch("/assistants/:name", async (c) => {
    const name = c.req.param("name");
    const change = await readJson(c, UpdateAssistantRequest);
    await guard(() => control.assistants.update(name, change));
    return c.json((await listAssistants(control)).find((a) => a.name === name)!);
  });

  app.delete("/assistants/:name", async (c) => {
    const name = c.req.param("name");
    if (control.owners.wouldLeaveNoOwner(name))
      throw new HttpError(
        409,
        `Every owner of this server is a player of ${name}: add an owner from another assistant first`,
      );
    const backup = await guard(() => control.assistants.remove(name, control.backupBeforeDelete));
    control.keys.deleteAssistant(name);
    control.owners.forgetAssistant(name);
    return c.json({ backup } satisfies DeleteAssistantResponse);
  });

  app.get("/keys", async (c) => {
    const assistant = c.req.query("assistant");
    return c.json({ keys: keyList(control, assistant) } satisfies ProviderKeysResponse);
  });

  app.put("/keys/:provider", async (c) => {
    const provider = c.req.param("provider");
    const body = await readJson(c, SetProviderKeyRequest);
    if (body.assistant !== undefined && !control.assistants.running.has(body.assistant))
      throw new HttpError(404, `No assistant "${body.assistant}"`);
    if (body.test !== false) {
      try {
        await control.testKey(provider, body.key);
      } catch (error) {
        throw new HttpError(400, `The key didn't work: ${(error as Error).message}`);
      }
    }
    control.keys.set(provider, body.key, body.assistant);
    return c.json(keyOf(control, provider, body.assistant));
  });

  app.delete("/keys/:provider", (c) => {
    const removed = control.keys.delete(c.req.param("provider"), c.req.query("assistant"));
    if (!removed) throw new HttpError(404, "No such key on the server");
    return c.body(null, 204);
  });

  app.post("/recovery-kit", async (c) => {
    const { passphrase } = await readJson(c, RecoveryKitRequest);
    const kit = sealRecoveryKit(await control.backupKey(), passphrase, options.publicUrl());
    return c.json({ kit } satisfies RecoveryKitResponse);
  });

  const backups = () => {
    if (control.backups === undefined)
      throw new HttpError(404, "This server doesn't make backups of its own");
    return control.backups;
  };

  app.get("/backups", async (c) => c.json((await backups().state()) satisfies BackupState));

  app.post("/backups", async (c) =>
    c.json((await guard(() => backups().backUpNow())) satisfies BackupNowResponse),
  );

  app.put("/backups/remote", async (c) => {
    const change = await readJson(c, SetBackupRemoteRequest);
    return c.json((await guard(() => backups().setRemote(change))) satisfies BackupState);
  });

  app.delete("/backups/remote", async (c) =>
    c.json((await guard(() => backups().removeRemote())) satisfies BackupState),
  );

  app.get("/owners", async (c) =>
    c.json({
      owners: control.owners.list().map(shownOwner),
    } satisfies ServerOwnersResponse),
  );

  app.post("/owners", async (c) => {
    const body = await readJson(c, AddOwnerRequest);
    if (body.address !== undefined) {
      const home = parseAddress(body.address);
      if (home === undefined) throw new HttpError(400, `Not an address: ${body.address}`);
      return c.json(shownOwner(await addFromHome(home)), 201);
    }
    if (body.assistant === undefined || body.playerId === undefined)
      throw new HttpError(400, "Give an address, or an assistant and a player there");
    const nudge = control.assistants.running.get(body.assistant);
    if (nudge === undefined) throw new HttpError(404, `No assistant "${body.assistant}"`);
    const player = await nudge.players.get(body.playerId, context);
    if (player === undefined)
      throw new HttpError(404, `No player "${body.playerId}" in ${body.assistant}`);
    if (body.admin === true) await nudge.players.setAdmin(body.playerId, true, context);
    // Someone who joined from their home elsewhere owns the server by their address.
    const owner =
      player.home === undefined
        ? control.owners.add(body.assistant, body.playerId)
        : await addFromHome(player.home);
    return c.json(shownOwner(owner), 201);
  });

  /** Makes the person at `home` an owner, with their home's keys pinned. */
  const addFromHome = async (home: PlayerHome): Promise<ServerOwner> => {
    const known = control.owners.ownerAt(home);
    if (known !== undefined) return known;
    const keys = await fetchKeys(home, control.fetch ?? fetch);
    if (keys === undefined) throw new HttpError(502, `Could not reach ${home.server}`);
    return control.owners.addAddress(addressOf(home), keys)!;
  };

  app.delete("/owners/:id", (c) => {
    let removed: boolean;
    try {
      removed = control.owners.remove(c.req.param("id"));
    } catch (error) {
      if (error instanceof LastOwner) throw new HttpError(409, error.message);
      throw error;
    }
    if (!removed) throw new HttpError(404, "No such owner");
    return c.body(null, 204);
  });

  return app;
}

/** Invites `address` to the assistant through its federation, as an admin would: the join link. */
async function inviteTo(nudge: Nudge, address: string): Promise<string> {
  const found = nudge.extensionRoute("federation", "POST", "/invites");
  if (found === undefined) throw new Error("it has no federation");
  const answer = await found.route.handle(
    new Request("http://server/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    }),
    { admin: true, params: {}, context },
  );
  const body = (await answer.json()) as { link?: string; error?: string };
  if (!answer.ok || body.link === undefined) throw new Error(body.error ?? `${answer.status}`);
  return body.link;
}

async function listAssistants(control: ServerControl): Promise<ServerAssistant[]> {
  return (await control.assistants.list()).map((entry) => toAssistant(control, entry));
}

function toAssistant(control: ServerControl, entry: AssistantConfig): ServerAssistant {
  const nudge = control.assistants.running.get(entry.name);
  return {
    name: entry.name,
    displayName: nudge?.displayName ?? entry.displayName ?? entry.name,
    model: entry.model ?? DEFAULT_MODEL,
    ...(entry.timeZone === undefined ? {} : { timeZone: entry.timeZone }),
    ...(entry.instructions === undefined ? {} : { instructions: entry.instructions }),
    ...(entry.budget === undefined ? {} : { budget: entry.budget }),
    running: nudge !== undefined,
  };
}

function keyList(control: ServerControl, assistant: string | undefined): ProviderKey[] {
  const providers = new Set([...WELL_KNOWN, ...control.keys.providers(assistant)]);
  return [...providers].sort().map((provider) => keyOf(control, provider, assistant));
}

function keyOf(control: ServerControl, provider: string, assistant?: string): ProviderKey {
  const source = control.keys.source(provider, assistant);
  if (source === undefined) return { provider, source: "none" };
  if (source.from === "env") return { provider, source: "env", variables: [...source.variables] };
  return { provider, source: source.from };
}

/** The server's errors as HTTP ones: a name in use, one not there, a setting that won't do. */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AssistantExists) throw new HttpError(409, error.message);
    if (error instanceof AssistantNotFound) throw new HttpError(404, error.message);
    if (error instanceof ConfigError) throw new HttpError(400, error.message);
    if (error instanceof WiredError) throw new HttpError(409, error.message);
    if (error instanceof GeoUnavailable) throw new HttpError(400, error.message);
    if (error instanceof BackupError) throw new HttpError(400, error.message);
    throw error;
  }
}

function bearer(c: HonoContext): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
}

/** An owner as the API shows them: without their home's keys. */
function shownOwner(owner: ServerOwner): ShownOwner {
  const { id, addedAt, assistant, playerId, address } = owner;
  return {
    id,
    addedAt,
    ...(assistant === undefined ? {} : { assistant }),
    ...(playerId === undefined ? {} : { playerId }),
    ...(address === undefined ? {} : { address }),
  };
}
