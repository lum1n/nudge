import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { defineNudgeExtension, defineTool, Type } from "@nudge/core";
import { DEFAULT_BROWSER_MODEL, runBrowserAgent } from "./agent.ts";
import type { BrowserSession } from "./browser.ts";
import { startLiveView } from "./live.ts";
import { LoginStore } from "./logins.ts";
import { holdBrowser, withBrowser } from "./pool.ts";

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
    model: Type.String({ default: DEFAULT_BROWSER_MODEL, pattern: "^[^/]+/.+$" }),
    reasoning: Type.Union(
      [Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
      { default: "low" },
    ),
    maxSteps: Type.Integer({ default: 30, minimum: 1, maximum: 100 }),
    /** Headless browsers are blocked by many sites; headed ones run on their own virtual display. */
    headless: Type.Boolean({ default: false }),
    /** Close a room's browser after this many minutes without a task. */
    idleMinutes: Type.Number({ default: 10, minimum: 1 }),
  }),
  setup: ({ settings, dataDir, timeZone, now }) => {
    const profiles = dataDir
      ? join(dataDir, "profiles")
      : mkdtempSync(join(tmpdir(), "nudge-browser-"));
    const logins = new LoginStore(dataDir ? join(dataDir, "logins") : undefined);
    const [provider, ...id] = settings.model.split("/");
    const idleMs = settings.idleMinutes * 60_000;
    // One browser profile and one set of saved logins per room.
    const scopeOf = (conversationId: number) => `conversation-${conversationId}`;
    const optionsFor = (conversationId: number) => ({
      profileDir: join(profiles, scopeOf(conversationId)),
      headless: settings.headless,
    });
    const useLogins = (session: BrowserSession, scope: string) =>
      session.useLogins(
        (host) => logins.find(scope, host),
        logins.list(scope).flatMap((login) => [login.username ?? "", login.password]),
      );
    return {
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
            const result = await withBrowser(optionsFor(api.conversationId), idleMs, (browser) => {
              useLogins(browser, scope);
              return runBrowserAgent({
                models: api.models,
                model,
                browser,
                task,
                reasoning: settings.reasoning as ThinkingLevel,
                maxSteps: settings.maxSteps,
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
      roomSocket: async ({ room }, socket) => {
        const scope = scopeOf(room.conversationId);
        const { session, release } = await holdBrowser(optionsFor(room.conversationId), idleMs);
        useLogins(session, scope);
        try {
          const live = await startLiveView(
            session,
            (output) => socket.send(JSON.stringify(output)),
            (remember) => {
              const captured = session.takeCaptured();
              if (!remember) return [];
              for (const login of captured) logins.save(scope, { ...login, savedAt: now() });
              useLogins(session, scope);
              return captured.map((login) => login.host);
            },
          );
          return {
            receive: (data) => live.receive(data),
            close: () => {
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
