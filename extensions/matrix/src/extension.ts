import { ChatBridge, fillVariables, sleep, untilOpen } from "@nudge/bridge";
import { defineNudgeExtension, type ExtensionHost, Type } from "@nudge/core";
import { MatrixClient, MatrixError } from "./matrix.ts";

const VERSION = "0.1.0";

const Settings = Type.Object({
  /** The bot account's homeserver, such as `https://matrix.example.org`. */
  homeserver: Type.String({
    pattern: "^https?://",
    description: "The bot account's homeserver, such as https://matrix.example.org.",
  }),
  /** The bot's access token; `${NAME}` takes it from the host's environment. */
  token: Type.String({
    default: "${MATRIX_ACCESS_TOKEN}",
    title: "Access token",
    description: "The bot account's access token; ${NAME} takes it from an environment variable.",
  }),
  /** Seconds one long poll waits for news. */
  pollSeconds: Type.Number({
    default: 30,
    minimum: 1,
    maximum: 60,
    description: "Seconds one request to the homeserver waits for new messages.",
  }),
});

export type MatrixOptions = {
  readonly fetch?: typeof fetch;
  readonly report?: (error: unknown) => void;
};

/** The Matrix bridge, with its HTTP client chosen; the default export uses the global `fetch`. */
export function matrixExtension(options: MatrixOptions = {}) {
  return defineNudgeExtension({
    name: "matrix",
    version: VERSION,
    description:
      "Talk to the assistant from Matrix rooms without end-to-end encryption, as a bot account.",
    settings: Settings,
    setup: (host) => {
      const report = options.report ?? ((error) => console.error("matrix:", error));
      const token = fillVariables(host.settings.token, process.env, "matrix");
      const client = new MatrixClient(host.settings.homeserver, token, options.fetch);
      const bridge = new ChatBridge(host, client, "matrix", report);
      const stop = new AbortController();
      const syncing = sync(host, client, bridge, host.settings.pollSeconds, stop.signal, report);
      return {
        onRoomEvent: (event) => bridge.onRoomEvent(event),
        close: async () => {
          stop.abort();
          await syncing;
        },
      };
    },
  });
}

/** Long-polls `/sync` once the assistant is open, joining rooms it is invited to, until `signal`. */
async function sync(
  host: Pick<ExtensionHost<unknown>, "assistant">,
  client: MatrixClient,
  bridge: ChatBridge,
  seconds: number,
  signal: AbortSignal,
  report: (error: unknown) => void,
): Promise<void> {
  await untilOpen(host, signal);
  while (!signal.aborted) {
    try {
      const since = (await bridge.state()).cursor;
      const response = await client.sync(since, seconds * 1000, signal);
      for (const roomId of Object.keys(response.rooms?.invite ?? {}))
        await client.join(roomId).catch(report);
      if (since !== undefined)
        for (const inbound of await client.inbound(response))
          await bridge.receive(inbound).catch(report);
      await bridge.setCursor(response.next_batch);
    } catch (error) {
      if (signal.aborted) return;
      report(error);
      await sleep(error instanceof MatrixError && error.status === 401 ? 60_000 : 5_000, signal);
    }
  }
}

export default matrixExtension();
