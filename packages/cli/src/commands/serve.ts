import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildModels, loadConfig, type Nudge, openAssistant } from "@nudge/core";
import { serveNudge } from "@nudge/server";
import { hostOptions, reloadOnHangup } from "../host.ts";

export type ServeOptions = {
  readonly config: string;
  readonly port: number;
  readonly host: string;
};

/** Runs every configured assistant behind one HTTP and WebSocket server until Ctrl-C. */
export async function serve(options: ServeOptions): Promise<void> {
  const context = BACKGROUND_CONTEXT;
  const config = await loadConfig(options.config);
  const models = buildModels(config.providers);
  const assistants = new Map<string, Nudge>();
  try {
    for (const assistant of config.assistants) {
      const nudge = await openAssistant(config, assistant, context, {
        ...hostOptions(assistant),
        models,
      });
      assistants.set(assistant.name, nudge);
    }
    const server = await serveNudge({ assistants, port: options.port, hostname: options.host });
    for (const name of assistants.keys()) console.log(`${name}: ${server.url}/a/${name}`);
    console.log("Connect with: NUDGE_TOKEN=… nudge chat --url <url above>");
    const stopReloading = reloadOnHangup(options.config, assistants);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    stopReloading();
    console.log("Stopping…");
    await server.close();
  } finally {
    for (const nudge of assistants.values()) await nudge.close(context);
  }
}
