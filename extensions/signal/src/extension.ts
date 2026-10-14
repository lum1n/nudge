import { ChatBridge } from "@nudge/bridge";
import { defineNudgeExtension, Type } from "@nudge/core";
import { parseAddress, SignalCli, toInbound } from "./signal.ts";

const VERSION = "0.1.0";

const Settings = Type.Object({
  /** Where `signal-cli daemon --tcp` listens. */
  daemon: Type.String({ default: "127.0.0.1:7583" }),
  /** The bot's own number, when the daemon serves several accounts (started without `-a`). */
  account: Type.Optional(Type.String({ pattern: "^\\+\\d+$" })),
});

export type SignalOptions = {
  readonly report?: (error: unknown) => void;
  /** Milliseconds between reconnects; tests make it short. */
  readonly retryMs?: number;
};

/** The Signal bridge; the default export takes the defaults. */
export function signalExtension(options: SignalOptions = {}) {
  return defineNudgeExtension({
    name: "signal",
    version: VERSION,
    description: "Talk to the assistant from Signal, through a signal-cli daemon on the host.",
    settings: Settings,
    setup: (host) => {
      const report = options.report ?? ((error) => console.error("signal:", error));
      // Deliveries are handled one at a time, in the order they came.
      let queue: Promise<void> = Promise.resolve();
      const signal: SignalCli = new SignalCli(
        parseAddress(host.settings.daemon),
        host.settings.account,
        (envelope) => {
          const inbound = toInbound(envelope);
          if (inbound === undefined) return;
          queue = queue.then(() => bridge.receive(inbound)).catch(report);
        },
        report,
      );
      const bridge = new ChatBridge(host, signal, "signal", report);
      // Messages are only taken once the assistant is open, so none arrive before it can answer.
      const opening = setInterval(() => {
        try {
          host.assistant();
        } catch {
          return;
        }
        clearInterval(opening);
        signal.start(options.retryMs);
      }, 100);
      return {
        onRoomEvent: (event) => bridge.onRoomEvent(event),
        close: () => {
          clearInterval(opening);
          signal.close();
        },
      };
    },
  });
}

export default signalExtension();
