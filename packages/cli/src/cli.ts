import { parseArgs } from "node:util";
import {
  admin as markAdmin,
  invite,
  nudges,
  pair,
  reload,
  revoke,
  room,
  token,
  tokens,
  usage,
} from "./commands/admin.ts";
import { chat } from "./commands/chat.ts";
import { connector } from "./commands/connector.ts";
import { db } from "./commands/db.ts";
import { doctor } from "./commands/doctor.ts";
import { init } from "./commands/init.ts";
import { serve } from "./commands/serve.ts";
import { UsageError } from "./errors.ts";

const USAGE = `Usage: nudge <command> [options]

Commands:
  init               Write a nudge.json in this directory
  chat [room]        Chat in this terminal; room is a room id, or "me" for your own
                     (default: the lobby)
  serve              Run every assistant behind an HTTP and WebSocket server
  invite <name>      Add a player and print their token
  pair <player>      Print a one-time code, link and QR code that signs an app in
  token <player>     Print a new token for a player, such as for a lost one
  tokens [player]    List the tokens of a player, or of everyone, by client id
  revoke <client>    Stop the token of a client id from signing in
  admin [player]     Let a player use the admin API (--remove: no longer), or list
                     the admins; the first player always may
  room [name]        Create a shared room with --members, or list the rooms
  nudges             List the scheduled nudges of every room
  usage              Model spend by month, player and room, and the budget
  connectors [room]  List the APIs a room can call (default: the lobby)
  connector share|unshare <id> [room]
                     Share a room's connector, one without a key, with every room, or
                     move a shared one back into the room
  db [encrypt|decrypt]
                     Show whether each database is encrypted, or encrypt or decrypt it in
                     place (stop "nudge serve" first). The key is NUDGE_DB_KEY, or a
                     <database>.key file that "encrypt" writes
  reload             Reinstall extensions from the config in the running assistant
  doctor             Check Node, config, storage and model credentials;
                     --ping sends one request, --privacy tests redaction

The admin commands (invite to connector) open the assistant's database. While "nudge serve"
has it open, they go through the server instead when given an admin's token (--token or
$NUDGE_TOKEN; --url when it isn't on --host and --port). invite and pair then print a
pairing code instead of a token.

Options:
  -c, --config <file>      Config file (default: nudge.json)
  -a, --assistant <name>   Assistant to use (default: the first one)
  -n, --name <name>        Your display name in chat
  -p, --player <id>        Chat in this process as this player (default: owner)
  -m, --members <ids>      Comma-separated player ids for a new room
  -u, --url <url>          Chat through a server: http://host:port (-a picks the assistant)
  -t, --token <token>      Token for --url (default: $NUDGE_TOKEN)
      --port <port>        serve: port (default: 8787)
      --host <host>        serve: interface (default: 127.0.0.1)
      --web <dir>          serve: web UI to host (default: the bundled one, if built;
                           "none" to serve only the API)
      --public-url <url>   serve: the address apps reach the server at, for pairing
                           links (default: each request's)
      --remove             admin: take the flag away
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: "nudge.json" },
      assistant: { type: "string", short: "a" },
      name: { type: "string", short: "n" },
      player: { type: "string", short: "p" },
      members: { type: "string", short: "m", default: "" },
      url: { type: "string", short: "u", default: process.env.NUDGE_URL },
      token: { type: "string", short: "t", default: process.env.NUDGE_TOKEN },
      port: { type: "string", default: "8787" },
      host: { type: "string", default: "127.0.0.1" },
      web: { type: "string" },
      "public-url": { type: "string" },
      ping: { type: "boolean", default: false },
      privacy: { type: "boolean", default: false },
      remove: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, argument, ...rest] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  const admin = { config: values.config, assistant: values.assistant };
  const server = values.url ?? `http://${values.host}:${values.port}`;
  const access = { ...admin, server, token: values.token };
  switch (command) {
    case "init":
      await init(values.config);
      return 0;
    case "chat":
      await chat({ ...admin, ...values, room: argument });
      return 0;
    case "serve": {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new UsageError(`--port ${values.port} is not a port`);
      await serve({
        config: values.config,
        port,
        host: values.host,
        web: values.web,
        publicUrl: values["public-url"],
      });
      return 0;
    }
    case "invite":
      if (argument === undefined) throw new UsageError("invite needs a name: nudge invite <name>");
      await invite({ ...access, name: argument });
      return 0;
    case "pair":
      if (argument === undefined)
        throw new UsageError("pair needs a player id: nudge pair <player>");
      await pair({ ...access, player: argument });
      return 0;
    case "token":
      if (argument === undefined)
        throw new UsageError("token needs a player id: nudge token <player>");
      await token({ ...access, player: argument });
      return 0;
    case "tokens":
      await tokens({ ...access, player: argument });
      return 0;
    case "revoke":
      if (argument === undefined)
        throw new UsageError("revoke needs a client id from nudge tokens: nudge revoke <client>");
      await revoke({ ...access, clientId: argument });
      return 0;
    case "admin":
      await markAdmin({ ...access, player: argument, remove: values.remove });
      return 0;
    case "room": {
      const members = values.members
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "");
      await room({ ...access, name: argument, members });
      return 0;
    }
    case "nudges":
      await nudges(access);
      return 0;
    case "usage":
      await usage(access);
      return 0;
    case "connectors":
      await connector({ ...access, room: argument });
      return 0;
    case "connector": {
      const [id, where] = rest;
      if ((argument !== "share" && argument !== "unshare") || id === undefined)
        throw new UsageError("Usage: nudge connector share|unshare <id> [room]");
      await connector({ ...access, verb: argument, id, room: where });
      return 0;
    }
    case "db":
      if (argument !== undefined && argument !== "encrypt" && argument !== "decrypt")
        throw new UsageError("Usage: nudge db [encrypt|decrypt]");
      await db({ ...admin, verb: argument });
      return 0;
    case "reload":
      return (await reload(admin)) ? 0 : 1;
    case "doctor":
      return (await doctor({ config: values.config, ping: values.ping, privacy: values.privacy }))
        ? 0
        : 1;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

const QUIET_ERRORS = new Set(["ConfigError", "UsageError", "DatabaseInUse", "DatabaseKeyError"]);

export function run(argv: string[]): void {
  main(argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error && QUIET_ERRORS.has(error.name) ? error.message : error);
      process.exit(1);
    },
  );
}
