import { ChatBridge, fillVariables, sleep, untilOpen } from "@nudge/bridge";
import { defineNudgeExtension, type ExtensionHost, Type } from "@nudge/core";
import { TelegramApi, TelegramError, toInbound } from "./telegram.ts";

const VERSION = "0.1.0";

const Settings = Type.Object({
  /** The bot's token from @BotFather; `${NAME}` takes it from the host's environment. */
  token: Type.String({ default: "${TELEGRAM_BOT_TOKEN}" }),
  /** Seconds one long poll waits for news. */
  pollSeconds: Type.Number({ default: 30, minimum: 1, maximum: 50 }),
  /** For tests and Bot API servers of your own. */
  apiBase: Type.String({ default: "https://api.telegram.org" }),
});

const COMMANDS = [
  { command: "link", description: "Link this account with a code from nudge pair" },
  { command: "rooms", description: "List your rooms" },
  { command: "room", description: "Pick the room this chat talks to" },
  { command: "stop", description: "Stop the answer in progress" },
  { command: "unlink", description: "Unlink this account" },
  { command: "help", description: "What the bot does" },
];

export type TelegramOptions = {
  /** The Bot API's transport; tests pass a fake one. */
  readonly fetch?: typeof fetch;
  readonly report?: (error: unknown) => void;
};

/** The Telegram bridge, with its HTTP client chosen; the default export uses the global `fetch`. */
export function telegramExtension(options: TelegramOptions = {}) {
  return defineNudgeExtension({
    name: "telegram",
    version: VERSION,
    description:
      "Talk to the assistant from Telegram. What goes through the bot is readable by Telegram.",
    settings: Settings,
    setup: (host) => {
      const report = options.report ?? ((error) => console.error("telegram:", error));
      const token = fillVariables(host.settings.token, process.env, "telegram");
      const api = new TelegramApi(token, host.settings.apiBase, options.fetch);
      const bridge = new ChatBridge(host, api, "telegram", report);
      const stop = new AbortController();
      const polling = poll(host, api, bridge, host.settings.pollSeconds, stop.signal, report);
      return {
        onRoomEvent: (event) => bridge.onRoomEvent(event),
        close: async () => {
          stop.abort();
          await polling;
        },
      };
    },
  });
}

/** Long-polls the Bot API once the assistant is open, handling updates in order, until `signal`. */
async function poll(
  host: Pick<ExtensionHost<unknown>, "assistant">,
  api: TelegramApi,
  bridge: ChatBridge,
  seconds: number,
  signal: AbortSignal,
  report: (error: unknown) => void,
): Promise<void> {
  await untilOpen(host, signal);
  if (signal.aborted) return;
  await api.setCommands(COMMANDS).catch(report);
  let offset = Number((await bridge.state()).cursor ?? 0);
  while (!signal.aborted) {
    try {
      for (const update of await api.getUpdates(offset, seconds, signal)) {
        const inbound = toInbound(update);
        if (inbound !== undefined) await bridge.receive(inbound).catch(report);
        offset = update.update_id + 1;
        // Saved after each, so a restart neither drops nor repeats one.
        await bridge.setCursor(String(offset));
      }
    } catch (error) {
      if (signal.aborted) return;
      report(error);
      // A token Telegram refuses won't get better soon.
      await sleep(error instanceof TelegramError && error.code === 401 ? 60_000 : 5_000, signal);
    }
  }
}

export default telegramExtension();
