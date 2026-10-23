import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Api, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import {
  type Approval,
  defineNudgeExtension,
  defineTool,
  requestApproval,
  returnsUntrusted,
  roomOf,
  Type,
} from "@nudge/core";
import {
  type BrowserAgentOptions,
  type BrowserAgentResult,
  cleanSiteNotes,
  DEFAULT_BROWSER_MODEL,
  runBrowserAgent,
} from "./agent.ts";
import type { BrowserSession } from "./browser.ts";
import { type LiveInput, type LiveOutput, startLiveView } from "./live.ts";
import { LoginStore } from "./logins.ts";
import { holdBrowser, withBrowser } from "./pool.ts";
import { type Viewer, viewersOf } from "./viewers.ts";

type SiteNote = { notes: string; at: number };
type SiteNotesState = { rooms: Record<string, Record<string, SiteNote>> };

/**
 * What the browser agent learned about using each site, by room and then host. Each room reads only
 * its own: a page can steer what the agent writes, and that must not reach other rooms' runs.
 *
 * Version 1 kept one set of notes shared by every room. Nothing tells which room a shared note came
 * from, so the move to version 2 drops them; rooms write fresh ones on their next visits.
 */
export const SiteNotesDoc = defineDoc<SiteNotesState>({
  kind: "browser.sites",
  version: 2,
  scope: "session",
  initial: () => ({ rooms: {} }),
  migrate: () => ({ rooms: {} }),
});

/** Sites whose notes a room keeps; the ones used longest ago go first. */
const MAX_SITES = 100;

/** What a `confirm` approval holds: the task a run stopped in, and the action to approve. */
type ConfirmPayload = { task: string; action: string };

/**
 * Lets the assistant use the web. The room's model delegates a task to `browse`; a browser agent on
 * its own, usually cheaper, model works a headed browser through text snapshots and returns the
 * answer. Its requests go through the assistant's redacting models like any other.
 */
export default defineNudgeExtension({
  name: "browser",
  version: "0.1.0",
  description: "Browse the web with a headed browser driven by its own model",
  settings: Type.Object({
    /** `provider/model` from the providers Nudge knows, such as `openai/gpt-5-mini`. */
    model: Type.String({
      default: DEFAULT_BROWSER_MODEL,
      pattern: "^[^/]+/.+$",
      description:
        "The model that drives the browser, as provider/model, such as openai/gpt-5-mini.",
    }),
    reasoning: Type.Union(
      [Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
      {
        default: "low",
        description:
          "How much the browser model thinks before each step; more is slower and costs more.",
      },
    ),
    maxSteps: Type.Integer({
      default: 30,
      minimum: 1,
      maximum: 100,
      description: "Most model turns the browser agent takes on one task before it gives up.",
    }),
    /** Headless browsers are blocked by many sites; headed ones run on their own virtual display. */
    headless: Type.Boolean({
      default: false,
      description:
        "Run the browser without a window; many sites block this, so leave it off unless you need it.",
    }),
    /** Close a room's browser after this many minutes without a task. */
    idleMinutes: Type.Number({
      default: 10,
      minimum: 1,
      description: "Minutes without a task before a room's browser is closed.",
    }),
    /** Let the browser reach localhost and the local network (routers, NAS, intranet). */
    allowPrivateNetwork: Type.Boolean({
      default: false,
      description:
        "Let the browser open localhost and devices on your local network, such as a router or NAS.",
    }),
    /** Keep short notes per site on how to use it, and show them on the next visit. */
    siteNotes: Type.Boolean({
      default: true,
      description:
        "Keep short notes on how to use each site and show them to the browser on its next visit in the same room.",
    }),
  }),
  setup: ({ settings, dataDir, timeZone, now, documents }) => {
    // Without a data directory (an in-memory assistant), profiles go to a temp dir made on first use.
    let temp: string | undefined;
    const profiles = () =>
      dataDir
        ? join(dataDir, "profiles")
        : (temp ??= mkdtempSync(join(tmpdir(), "nudge-browser-")));
    const logins = new LoginStore(dataDir ? join(dataDir, "logins") : undefined);
    const [provider, ...id] = settings.model.split("/");
    const idleMs = settings.idleMinutes * 60_000;
    // One browser profile and one set of saved logins per room.
    const scopeOf = (conversationId: number) => `conversation-${conversationId}`;
    const optionsFor = (conversationId: number) => ({
      profileDir: join(profiles(), scopeOf(conversationId)),
      headless: settings.headless,
      blockPrivateNetwork: !settings.allowPrivateNetwork,
    });
    const useLogins = (session: BrowserSession, scope: string) =>
      session.useLogins(
        (host) => logins.find(scope, host),
        logins.list(scope).flatMap((login) => [login.username ?? "", login.password]),
      );

    /** One run of the browser agent in a room's browser, with site notes if they are on. */
    const browseIn = async (
      run: {
        readonly models: Models;
        readonly conversationId: number;
        /** The site notes kept so far. */
        readonly notes: () => Promise<SiteNotesState | undefined>;
        readonly commit: <T>(apply: (tx: Tx) => Promise<T> | T) => Promise<T>;
        readonly context: Context;
      },
      task: string,
      extra: Pick<BrowserAgentOptions, "approved" | "onStep">,
    ): Promise<BrowserAgentResult | undefined> => {
      const model = run.models.getModel(provider!, id.join("/")) as Model<Api> | undefined;
      if (!model) return undefined;
      const scope = scopeOf(run.conversationId);
      const known = settings.siteNotes ? ((await run.notes())?.rooms[scope] ?? {}) : {};
      const siteNotes = settings.siteNotes
        ? {
            read: (host: string) => known[host]?.notes,
            write: (notes: Readonly<Record<string, string>>) =>
              run.commit(async (tx) => {
                const doc = await tx.doc(SiteNotesDoc);
                doc.rooms[scope] ??= {};
                // Read back: the document's copy, not the object assigned.
                const sites = doc.rooms[scope];
                for (const [host, text] of Object.entries(notes)) {
                  const clean = cleanSiteNotes(text);
                  if (clean !== "") sites[host] = { notes: clean, at: now() };
                }
                const hosts = Object.entries(sites).sort(([, a], [, b]) => b.at - a.at);
                for (const [host] of hosts.slice(MAX_SITES)) delete sites[host];
              }),
          }
        : undefined;
      return withBrowser(optionsFor(run.conversationId), idleMs, (browser) => {
        useLogins(browser, scope);
        return runBrowserAgent({
          models: run.models,
          model,
          browser,
          task,
          reasoning: settings.reasoning as ThinkingLevel,
          maxSteps: settings.maxSteps,
          ...(siteNotes === undefined ? {} : { siteNotes }),
          timeZone,
          now,
          ...(run.context.abortSignal ? { signal: run.context.abortSignal } : {}),
          ...extra,
        });
      });
    };

    /**
     * Files an approval for the action a run stopped at. Approving it runs the task again in the
     * same room's browser, allowed to do exactly that action (`approvals.confirm`).
     */
    const askToConfirm = (
      commit: <T>(apply: (tx: Tx) => Promise<T> | T) => Promise<T>,
      roomId: string,
      task: string,
      action: string,
    ): Promise<Approval> =>
      commit((tx) =>
        requestApproval(
          tx,
          roomId,
          {
            extension: "browser",
            kind: "confirm",
            summary: `In the browser: ${action}`,
            payload: { task, action } satisfies ConfirmPayload,
          },
          now(),
        ),
      );

    const unavailable = `The browser model "${settings.model}" is not available. Set "model" in the browser extension's settings in nudge.json.`;
    const stopped = (result: BrowserAgentResult) =>
      `Browsing stopped (${result.outcome}${result.error ? `: ${result.error}` : ""}) after ${result.steps} steps.${result.answer ? `\n${result.answer}` : ""}`;

    return {
      models: [{ provider: provider!, modelId: id.join("/") }],
      // What it found on the web is data, not instructions (ADR 20).
      tools: [
        defineTool({
          name: "browse",
          description:
            "Use the web: look things up on websites, search listings, compare prices, read timetables or fill in search forms. A separate browser agent does the task and returns its answer with links. Give it a complete, self-contained task saying what to find and what to report. It logs in with logins the user saved; when a site needs a new login it stops and asks the user to log in in this room's browser. Before it buys, books, sends or signs up for anything it stops and asks the people in the room to approve that exact action; once approved, it carries on by itself.",
          parameters: Type.Object({
            task: Type.String({ minLength: 1, description: "What to do and what to report back" }),
          }),
          execute: async ({ task }, api, context) => {
            // People in the room see the last line while it runs (`ToolPart.output`).
            api.output("Starting the browser…\n");
            const result = await browseIn(
              {
                models: api.models,
                conversationId: api.conversationId,
                notes: () => api.snapshot(SiteNotesDoc, context),
                commit: (apply) => api.commit(apply, context),
                context,
              },
              task,
              {
                onStep: (step) => {
                  if (step.type === "doing") api.output(`${step.text}\n`);
                },
              },
            );
            if (result === undefined)
              return { output: [{ type: "text", text: unavailable }], isError: true };
            const details = { steps: result.steps, actions: result.actions, model: settings.model };
            if (result.outcome === "needs-login") {
              return {
                output: [
                  {
                    type: "text",
                    text: `${result.answer}\nAsk the user to open this room's browser in the Nudge web app (the Browser button), log in there and press Done; then try again.`,
                  },
                ],
                usage: result.usage,
                details: { ...details, needsLogin: true },
              };
            }
            if (result.outcome === "needs-confirmation") {
              const room = await roomOf(api, api.conversationId, context);
              const approval = await askToConfirm(
                (apply) => api.commit(apply, context),
                room.id,
                task,
                result.action ?? "",
              );
              return {
                output: [
                  {
                    type: "text",
                    text: `The browser stopped before this step and asked the room to approve it (approval ${approval.id}): ${result.action}\nOnce someone approves, it carries on by itself and the room hears how it went. Don't browse for this again meanwhile.`,
                  },
                ],
                usage: result.usage,
                // `approval` puts Approve and Deny in the chat, as for any approval.
                details: { ...details, approval: approval.id },
              };
            }
            const answered = result.outcome === "answered";
            return {
              output: [{ type: "text", text: answered ? result.answer : stopped(result) }],
              isError: !answered,
              usage: result.usage,
              details,
            };
          },
        }),
      ].map(returnsUntrusted),
      approvals: {
        // The action a `browse` run stopped at, approved: the same task again, in the room's
        // browser where the run left it, allowed to do exactly that.
        confirm: async (payload, run) => {
          const { task, action } = payload as ConfirmPayload;
          const result = await browseIn(
            {
              models: run.models,
              conversationId: run.room.conversationId,
              notes: () => documents().snapshot(SiteNotesDoc, run.context),
              commit: run.commit,
              context: run.context,
            },
            task,
            { approved: action },
          );
          if (result === undefined) return { text: unavailable, isError: true };
          // The outcome reaches the model as input, so what the web said is marked there too.
          if (result.outcome === "answered")
            return { text: result.answer, usage: result.usage, untrusted: "browse" };
          if (result.outcome === "needs-confirmation") {
            const next = await askToConfirm(run.commit, run.room.id, task, result.action ?? "");
            return {
              text: `${result.answer ? `${result.answer}\n` : ""}It stopped again before another step, which waits for approval ${next.id}: ${result.action}`,
              usage: result.usage,
              untrusted: "browse",
            };
          }
          if (result.outcome === "needs-login")
            return {
              text: `${result.answer}\nSomeone has to open this room's browser in the Nudge web app, log in there and press Done; then ask again.`,
              usage: result.usage,
              isError: true,
            };
          return { text: stopped(result), usage: result.usage, isError: true };
        },
      },
      // The room's browser, live, for the people in the room: watch it, take over, log in.
      roomSocket: async ({ room, player }, socket) => {
        const scope = scopeOf(room.conversationId);
        const { session, release } = await holdBrowser(optionsFor(room.conversationId), idleMs);
        useLogins(session, scope);
        const viewers = viewersOf(scope);
        const viewer: Viewer = {
          name: player.displayName,
          send: (output) => socket.send(JSON.stringify(output)),
        };
        const savedLogins = (): LiveOutput => ({
          type: "logins",
          logins: logins.list(scope).map(({ host, username, savedAt }) => ({
            host,
            ...(username === undefined ? {} : { username }),
            savedAt,
          })),
        });
        try {
          const live = await startLiveView(session, viewer.send, (remember) => {
            const captured = session.takeCaptured();
            if (!remember) return [];
            for (const login of captured) logins.save(scope, { ...login, savedAt: now() });
            useLogins(session, scope);
            viewers.broadcast(savedLogins());
            return captured.map((login) => login.host);
          });
          viewers.join(viewer);
          viewer.send(savedLogins());
          return {
            receive: (data) => {
              const input = JSON.parse(data) as LiveInput;
              if (input.type === "take") return viewers.take(viewer);
              if (input.type === "forget") {
                logins.forget(scope, input.host);
                useLogins(session, scope);
                return viewers.broadcast(savedLogins());
              }
              // Only the one in control drives the browser; the others watch.
              if (viewers.holder !== viewer)
                return viewer.send({
                  type: "error",
                  message: `${viewers.holder?.name ?? "Someone"} is using the browser. Take control to use it.`,
                });
              live.receive(data);
            },
            close: () => {
              viewers.leave(viewer);
              live.close();
              release();
            },
          };
        } catch (error) {
          release();
          throw error;
        }
      },
    };
  },
});
