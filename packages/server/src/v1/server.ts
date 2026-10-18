import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantConfig,
  AssistantExists,
  AssistantNotFound,
  type Assistants,
  ConfigError,
  DEFAULT_MODEL,
  defaultExtensions,
  LastOwner,
  type Nudge,
  type NudgeConfig,
  sealRecoveryKit,
  type ServerKeys,
  type ServerOwner,
  type ServerOwners,
  type TailscaleState,
  WiredError,
} from "@nudge/core";
import {
  AddOwnerRequest,
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
  type ServerOwnersResponse,
  ServerSessionRequest,
  type ServerSessionResponse,
  SetProviderKeyRequest,
  SetUpdatesRequest,
  TailscaleConnectRequest,
  WiredJoinRequest,
  WiredRelayRequest,
  type WiredRelayResponse,
  type WiredState,
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
  /** Backs up the assistant `config` holds before it is deleted; returns the backup's name. */
  backupBeforeDelete(config: NudgeConfig): Promise<string>;
  /** Sends one tiny request with the key, throwing with the provider's answer when it fails. */
  testKey(provider: string, key: string): Promise<void>;
  /** The key the server's backups are encrypted with, for the recovery kit. */
  backupKey(): Promise<Buffer>;
  /** Self-update, for a server `nudge-server` runs; absent otherwise. */
  readonly updates?: UpdateControl;
  /** The server's own Tailscale, on Linux; absent elsewhere. */
  readonly tailscale?: TailscaleControl;
  /** The server's Wired; absent where the server wasn't given one. */
  readonly wired?: WiredControl;
};

/** What owners see of and do with the server's Wired. */
export type WiredControl = {
  state(): WiredState;
  /** Makes this server the network's root. */
  enable(): Promise<WiredState>;
  /** On the root: lists a new server's relay and answers with the invite it joins with. */
  addRelay(url: string): Promise<string>;
  /** Joins the network an invite is for, serving a relay at the public address or `relayUrl`. */
  join(invite: string, relayUrl?: string): Promise<WiredState>;
};

/** What owners see of and do with the server's Tailscale. */
export type TailscaleControl = {
  state(): Promise<TailscaleState>;
  /** Joins the tailnet, with a login URL in the state when no key was given. */
  connect(authKey?: string): Promise<TailscaleState>;
  disconnect(): Promise<TailscaleState>;
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
};

type Env = { Variables: { owner: ServerOwner; clientId: string } };

/**
 * The server's own API (ADR 11), to mount at `/v1/server`: for its owners, with a server token,
 * to create, change and delete assistants and to set the model keys. A player of one of its
 * assistants who is an owner trades their player token for a server token at `POST /session`.
 */
export function serverRoutes(options: ServerRoutesOptions): Hono<Env> {
  const { control } = options;
  const app = new Hono<Env>();

  app.post("/session", async (c) => {
    const body = await readJson(c, ServerSessionRequest);
    const nudge = control.assistants.running.get(body.assistant);
    const token = bearer(c);
    const credential =
      nudge === undefined || token === undefined
        ? undefined
        : await nudge.players.authenticate(token, context);
    if (credential === undefined) throw new HttpError(401, "Missing or unknown token");
    const owner = control.owners.ownerOf(body.assistant, credential.player.id);
    if (owner === undefined) throw new HttpError(403, "Only the server's owners may do that");
    const issued = control.owners.issue(owner.id, body.client);
    return c.json({ ...issued, owner } satisfies ServerSessionResponse, 201);
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
      owner: c.var.owner,
      assistants: await listAssistants(control),
      ...(control.updates === undefined ? {} : { updates: control.updates.state() }),
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

  const tailscale = () => {
    if (control.tailscale === undefined)
      throw new HttpError(404, "This server can't run Tailscale: it only runs on Linux");
    return control.tailscale;
  };

  app.get("/tailscale", async (c) => c.json(await tailscale().state()));

  app.post("/tailscale", async (c) => {
    const { authKey } = await readJson(c, TailscaleConnectRequest);
    return c.json(await tailscale().connect(authKey));
  });

  app.delete("/tailscale", async (c) => c.json(await tailscale().disconnect()));

  const wired = () => {
    if (control.wired === undefined) throw new HttpError(404, "This server has no Wired");
    return control.wired;
  };

  app.get("/wired", (c) => c.json(wired().state() satisfies WiredState));

  app.post("/wired", async (c) => c.json((await wired().enable()) satisfies WiredState));

  app.post("/wired/join", async (c) => {
    const { invite, relayUrl } = await readJson(c, WiredJoinRequest);
    return c.json((await guard(() => wired().join(invite, relayUrl))) satisfies WiredState);
  });

  app.post("/wired/relays", async (c) => {
    const { url } = await readJson(c, WiredRelayRequest);
    const invite = await guard(() => wired().addRelay(url));
    return c.json({ invite } satisfies WiredRelayResponse);
  });

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

  app.get("/owners", (c) =>
    c.json({ owners: control.owners.list() } satisfies ServerOwnersResponse),
  );

  app.post("/owners", async (c) => {
    const body = await readJson(c, AddOwnerRequest);
    const nudge = control.assistants.running.get(body.assistant);
    if (nudge === undefined) throw new HttpError(404, `No assistant "${body.assistant}"`);
    if ((await nudge.players.get(body.playerId, context)) === undefined)
      throw new HttpError(404, `No player "${body.playerId}" in ${body.assistant}`);
    if (body.admin === true) await nudge.players.setAdmin(body.playerId, true, context);
    return c.json(control.owners.add(body.assistant, body.playerId), 201);
  });

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
    throw error;
  }
}

function bearer(c: HonoContext): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
}
