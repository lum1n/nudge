import { createHash, timingSafeEqual } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  findAssistant,
  type Invitation,
  type Nudge,
  type NudgeOptions,
  openAssistant,
} from "@nudge/core";
import type { AssistantsResponse } from "@nudge/protocol";
import { HttpError, v1Routes } from "@nudge/server/v1";
import { Hono } from "hono";
import { type NudgeEnv, readConfig } from "./config.ts";
import { upgradeWebSocket } from "./websocket.ts";

const context = BACKGROUND_CONTEXT;

/** Which assistant this Durable Object is, kept so an alarm can open it without a request. */
const NAME_KEY = "nudge.assistant";
/** How long an alarm waits for the nudges it woke for to fire. */
const FIRE_TIMEOUT_MS = 60_000;
/** When a nudge is still due after that, how long until the next try. */
const RETRY_MS = 30_000;

type Opened = { readonly nudge: Nudge; readonly app: Hono };

export type AssistantListing = AssistantsResponse["assistants"][number];

/**
 * One assistant, in a SQLite-backed Durable Object of its own: its storage is the object's, so
 * no file lock is needed, as the platform runs one instance per assistant. It opens on every wake,
 * so pending tasks resume, and keeps an alarm at its next nudge, so a nudge fires on time also
 * when the object was evicted in between. A deploy, such as one that changes `NUDGE_CONFIG`,
 * restarts every object with the new config, which is what `nudge reload` does on a server.
 *
 * Extensions are given in code: subclass it, override `options`, and export the subclass under the
 * class name the wrangler config binds.
 */
export class NudgeAssistant extends DurableObject<NudgeEnv> {
  private opening: Promise<Opened> | undefined;

  constructor(ctx: DurableObjectState, env: NudgeEnv) {
    super(ctx, env);
    const name = ctx.storage.kv.get<string>(NAME_KEY);
    // Open on every wake, so pending tasks resume; a failure resets the object for the next try.
    if (name !== undefined) this.open(name).catch((error: unknown) => console.error(error));
  }

  /** What to open `assistant` with beyond its config, such as `extensions`. */
  protected options(_assistant: string): Partial<NudgeOptions> {
    return {};
  }

  override async fetch(request: Request): Promise<Response> {
    const name = /^\/v1\/a\/([^/]+)/.exec(new URL(request.url).pathname)?.[1];
    if (name === undefined) return Response.json({ error: "Not found" }, { status: 404 });
    const { app } = await this.open(this.claimName(name));
    return app.fetch(request);
  }

  /** What `GET /v1/a` lists for this assistant. */
  async listing(name: string): Promise<AssistantListing> {
    const { app } = await this.open(this.claimName(name));
    const response = await app.request("/v1/a");
    const { assistants } = (await response.json()) as AssistantsResponse;
    const [listing] = assistants;
    if (listing === undefined) throw new Error(`Assistant "${name}" did not list itself`);
    return listing;
  }

  /** Woken at the next nudge: waits for the due ones to fire and be answered, then sets the next. */
  override async alarm(): Promise<void> {
    const name = this.ctx.storage.kv.get<string>(NAME_KEY);
    // An assistant taken out of the config keeps its data, but wakes no more.
    if (name === undefined || !readConfig(this.env).assistants.some((a) => a.name === name)) return;
    const { nudge } = await this.open(name);
    // Timers whose time has come fire as the assistant opens, or now if it was open already.
    const deadline = Date.now() + FIRE_TIMEOUT_MS;
    while ((await nudge.nudges.list(context)).some((due) => due.fireAt <= Date.now())) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The object stays awake for the answers to them.
    await nudge.harness.waitForIdle(context);
    await this.arm(nudge, Date.now() + RETRY_MS);
  }

  /** The name the object was first reached by; it is for that assistant only. */
  private claimName(name: string): string {
    const stored = this.ctx.storage.kv.get<string>(NAME_KEY);
    if (stored !== undefined) return stored;
    this.ctx.storage.kv.put(NAME_KEY, name);
    return name;
  }

  /** Opens the assistant once; nothing else reaches the object until it is open. */
  private open(name: string): Promise<Opened> {
    this.opening ??= this.ctx.blockConcurrencyWhile(() => this.start(name));
    return this.opening;
  }

  private async start(name: string): Promise<Opened> {
    const config = readConfig(this.env);
    const report = (error: unknown) => console.error(error);
    const nudge = await openAssistant(config, findAssistant(config, name), context, {
      onReport: report,
      ...this.options(name),
      storage: await openDurableObjectSqliteStorage(this.ctx.storage),
    });
    nudge.changes.subscribe((change) => {
      if (change.kind === "nudges") this.arm(nudge).catch(report);
    });
    await this.arm(nudge);

    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
      report(error);
      return c.json({ error: "Internal error" }, 500);
    });
    app.notFound((c) => c.json({ error: "Not found" }, 404));
    app.post("/v1/a/:assistant/claim", async (c) => {
      const secret = this.env.NUDGE_CLAIM_SECRET;
      const given = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      if (secret === undefined || secret === "" || given === undefined || !same(given, secret))
        throw new HttpError(401, "Missing or wrong claim secret");
      const body = (await c.req.json().catch(() => ({}))) as { displayName?: unknown };
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      if (displayName === "") throw new HttpError(400, "A claim needs a displayName");
      // One claim at a time, so two can't both find no players. Nothing may throw in there: that
      // would reset the object.
      const claimed = await this.ctx.blockConcurrencyWhile(() =>
        claimFirst(nudge, displayName).catch((error: unknown) => error as Error),
      );
      if (claimed === undefined) throw new HttpError(409, "The assistant has players already");
      if (claimed instanceof Error) throw claimed;
      const { player, token } = claimed;
      return c.json({ token, player: { id: player.id, displayName: player.displayName } });
    });
    app.route(
      "/v1",
      v1Routes({
        assistants: new Map([[name, nudge]]),
        upgradeWebSocket,
        version: "0.0.0",
        report,
        publicUrl: this.env.NUDGE_PUBLIC_URL,
      }),
    );
    return { nudge, app };
  }

  /** Sets the alarm at the next nudge, not before `notBefore`; clears it when none is pending. */
  private async arm(nudge: Nudge, notBefore = 0): Promise<void> {
    const next = (await nudge.nudges.list(context))[0];
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next.fireAt, notBefore));
  }
}

/** The first player, an admin; undefined when the assistant has players already. */
async function claimFirst(nudge: Nudge, displayName: string): Promise<Invitation | undefined> {
  if ((await nudge.players.list(context)).length > 0) return undefined;
  return nudge.players.invite(displayName, context);
}

function same(given: string, secret: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(secret));
}
