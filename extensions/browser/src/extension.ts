import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";
import { defineNudgeExtension, defineTool, Type } from "@nudge/core";
import { DEFAULT_BROWSER_MODEL, runBrowserAgent } from "./agent.ts";

/** What the browser agent learned about using each site, by host; shared by every room. */
export const SiteNotesDoc = defineDoc<{ sites: Record<string, { notes: string; at: number }> }>({
  kind: "browser.sites",
  version: 1,
  scope: "session",
  initial: () => ({ sites: {} }),
});

/** Sites whose notes are kept; the ones used longest ago go first. */
const MAX_SITES = 300;
import type { BrowserSession } from "./browser.ts";
import { type LiveInput, type LiveOutput, startLiveView } from "./live.ts";
import { LoginStore } from "./logins.ts";
import { holdBrowser, withBrowser } from "./pool.ts";
import { type Viewer, viewersOf } from "./viewers.ts";

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
        "Keep short notes on how to use each site and show them to the browser on its next visit.",
    }),
  }),
  setup: ({ settings, dataDir, timeZone, now }) => {
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
    return {
      models: [{ provider: provider!, modelId: id.join("/") }],
      tools: [
        defineTool({
          name: "browse",
          description:
            "Use the web: look things up on websites, search listings, compare prices, read timetables or fill in search forms. A separate browser agent does the task and returns its answer with links. Give it a complete, self-contained task saying what to find and what to report. It logs in with logins the user saved; when a site needs a new login it stops and asks the user to log in in this room's browser. It cannot buy anything or send messages.",
          parameters: Type.Object({
            task: Type.String({ minLength: 1, description: "What to do and what to report back" }),
          }),
          execute: async ({ task }, api, context) => {
            const model = api.models.getModel(provider!, id.join("/")) as Model<Api> | undefined;
            if (!model) {
              return {
                output: [
                  {
                    type: "text",
                    text: `The browser model "${settings.model}" is not available. Set "model" in the browser extension's settings in nudge.json.`,
                  },
                ],
                isError: true,
              };
            }
            const scope = scopeOf(api.conversationId);
            const known = settings.siteNotes
              ? ((await api.snapshot(SiteNotesDoc, context))?.sites ?? {})
              : {};
            const siteNotes = settings.siteNotes
              ? {
                  read: (host: string) => known[host]?.notes,
                  write: (notes: Readonly<Record<string, string>>) =>
                    api.commit(async (tx) => {
                      const doc = await tx.doc(SiteNotesDoc);
                      for (const [host, text] of Object.entries(notes))
                        doc.sites[host] = { notes: text, at: now() };
                      const hosts = Object.entries(doc.sites).sort(([, a], [, b]) => b.at - a.at);
                      for (const [host] of hosts.slice(MAX_SITES)) delete doc.sites[host];
                    }, context),
                }
              : undefined;
            const result = await withBrowser(optionsFor(api.conversationId), idleMs, (browser) => {
              useLogins(browser, scope);
              return runBrowserAgent({
                models: api.models,
                model,
                browser,
                task,
                reasoning: settings.reasoning as ThinkingLevel,
                maxSteps: settings.maxSteps,
                ...(siteNotes === undefined ? {} : { siteNotes }),
                timeZone,
                now,
                ...(context.abortSignal ? { signal: context.abortSignal } : {}),
                onStep: (step) => {
                  if (step.type === "action")
                    void api.details({ step: step.step, action: step.tool, ok: step.ok }, context);
                },
              });
            });
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
            const answered = result.outcome === "answered";
            const text = answered
              ? result.answer
              : `Browsing stopped (${result.outcome}${result.error ? `: ${result.error}` : ""}) after ${result.steps} steps.${result.answer ? `\n${result.answer}` : ""}`;
            return {
              output: [{ type: "text", text }],
              isError: !answered,
              usage: result.usage,
              details,
            };
          },
        }),
      ],
      // The room's browser, live, for the people in the room: watch it, take over, log in.
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
