import type { HealthResponse } from "@nudge/protocol";
import { type NudgeEnv, readConfig } from "./config.ts";

export { NudgeAssistant } from "./assistant.ts";

/**
 * Protocol v1 under `/v1`: `GET /v1/health` for a monitor, `GET /v1/a` lists the configured
 * assistants, and everything under `/v1/a/<assistant>` goes to that assistant's Durable Object,
 * WebSockets included.
 */
export async function handle(request: Request, env: NudgeEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  const config = readConfig(env);
  // As a server's, without a token, but from the config alone: asking every Durable Object would
  // wake them all, so `assistants` counts the configured ones, and the last model error, which
  // each object keeps to itself, is left out. A config that doesn't read fails it, with a 500.
  if (path === "/v1/health" && request.method === "GET")
    return Response.json({
      ok: true,
      assistants: config.assistants.length,
    } satisfies HealthResponse);
  const stub = (name: string) => env.NUDGE_ASSISTANT.getByName(name);
  if (path === "/v1/a" && request.method === "GET")
    return Response.json({
      assistants: await Promise.all(config.assistants.map(({ name }) => stub(name).listing(name))),
    });
  const name = /^\/v1\/a\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  if (name === undefined) return Response.json({ error: "Not found" }, { status: 404 });
  if (!config.assistants.some((assistant) => assistant.name === name))
    return Response.json({ error: `No assistant "${name}"` }, { status: 404 });
  return stub(name).fetch(request);
}

export default { fetch: handle } satisfies ExportedHandler<NudgeEnv>;
