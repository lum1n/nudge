import type { WiredState } from "@nudge/core";
import { UsageError } from "../errors.ts";

export type WiredCommandOptions = {
  /** The server to ask; default this computer's. */
  readonly url?: string;
  /** An owner's token for that server (`nudge owner token <player>` there). */
  readonly token?: string;
  /** With `on` and `join`: its name in the network, such as `box`. */
  readonly name?: string;
  readonly verb?: string;
  readonly arg?: string;
};

const USAGE =
  "Usage: nudge wired [status|on|add <https-url>|join <invite>|remove <name>] --token <owner token> [--name <its name in the network>]";

/**
 * `nudge wired`: the server's Wired, an encrypted network between Nudge servers that needs no
 * open port at home. On home: `on`, then `add https://robin.exe.xyz` for each other server, which
 * prints the invite that server joins with: `nudge wired join <invite> --url https://robin.exe.xyz`.
 * `remove <name>` on home takes a server that's gone out of the network, freeing its name.
 * `--name box` with `on` or `join` picks the server's name in the network: others reach it at
 * `http://nudge.box.wired`. Without it, it is the public address's first label, or the host's.
 */
export async function wired(options: WiredCommandOptions): Promise<void> {
  const base = new URL(options.url ?? "http://127.0.0.1:8787").origin;
  const token = options.token;
  if (token === undefined)
    throw new UsageError(
      `${USAGE}\nIt needs an owner's token for the server: nudge owner token <player> there`,
    );
  const call = async (method: string, path: string, body?: object): Promise<unknown> => {
    const response = await fetch(`${base}/v1/server/wired${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new UsageError(answer.error ?? `${base} answered ${response.status}`);
    return answer;
  };
  const named = options.name === undefined ? {} : { name: options.name };
  switch (options.verb) {
    case undefined:
    case "status":
      describe((await call("GET", "")) as WiredState);
      return;
    case "on":
      describe((await call("POST", "", named)) as WiredState);
      return;
    case "add": {
      if (options.arg === undefined) throw new UsageError(USAGE);
      const { invite } = (await call("POST", "/relays", { url: options.arg })) as { invite: string };
      console.log(invite);
      console.log(
        `(The invite is a credential. On that server: nudge wired join <invite> --url ${options.arg})`,
      );
      return;
    }
    case "remove":
      if (options.arg === undefined) throw new UsageError(USAGE);
      describe((await call("DELETE", `/members/${encodeURIComponent(options.arg)}`)) as WiredState);
      return;
    case "join":
      if (options.arg === undefined) throw new UsageError(USAGE);
      describe((await call("POST", "/join", { invite: options.arg, ...named })) as WiredState);
      return;
    default:
      throw new UsageError(USAGE);
  }
}

function describe(state: WiredState): void {
  switch (state.state) {
    case "root":
    case "member":
      console.log(
        `${state.state === "root" ? "Holds" : "Is in"} the network as ${state.name}: others reach it at http://nudge.${state.name}.wired`,
      );
      for (const m of state.members ?? []) console.log(`  ${m.name}${m.anchor ? " (holds it)" : ""}`);
      if (state.relays !== undefined && state.relays.length > 0)
        console.log(`Relays: ${state.relays.join(", ")}`);
      else console.log("No relays yet: nudge wired add <https-url of a server with a public address>");
      if (state.relay !== undefined) console.log(`Serves a relay at ${state.relay}`);
      return;
    case "unavailable":
      console.log("This release has no Wired.");
      return;
    case "error":
      console.log(`Wired failed: ${state.error}`);
      return;
    default:
      console.log(
        `Wired is ${state.state}.${state.state === "off" && state.name !== undefined ? ` Turned on, it goes by ${state.name}.` : ""}`,
      );
  }
}
