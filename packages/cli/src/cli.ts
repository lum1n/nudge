import { parseArgs } from "node:util";
import { defaultConfigPath } from "@nudge/core";
import {
  admin as markAdmin,
  invite,
  nudges,
  pair,
  reload,
  renameRoom,
  revoke,
  room,
  token,
  tokens,
  usage,
} from "./commands/admin.ts";
import { backup, restore } from "./commands/backup.ts";
import { chat } from "./commands/chat.ts";
import { connector } from "./commands/connector.ts";
import { db } from "./commands/db.ts";
import { doctor } from "./commands/doctor.ts";
import { kit, setup } from "./commands/setup.ts";
import { owner } from "./commands/owner.ts";
import { wired } from "./commands/wired.ts";
import { serve } from "./commands/serve.ts";
import { UsageError } from "./errors.ts";

const USAGE = `Usage: nudge <command> [options]

Commands:
  setup              Set this server up: name an assistant, pick its model and key, and
                     become its owner (init does the same). Or run "nudge serve" without a
                     config, and set it up in the browser with the code it prints
  chat [room]        Chat in this terminal; room is a room id, or "me" for your own
                     (default: the lobby)
  serve              Run every assistant behind an HTTP and WebSocket server
  invite <name>      Add a player and print their token; with an address such as
                     ann@nudge.example.com/robin, let someone from another assistant join
  pair <player>      Print a one-time code, link and QR code that signs an app in
  token <player>     Print a new token for a player, such as for a lost one
  tokens [player]    List the tokens of a player, or of everyone, by client id
  revoke <client>    Stop the token of a client id from signing in
  admin [player]     Let a player use the admin API (--remove: no longer), or list
                     the admins; the first player always may
  room [name]        Create a shared room with --members, or list the rooms
  room rename <id> <name>
                     Give a room a new name; its id stays
  nudges             List the scheduled nudges of every room
  usage              Model spend by month, player and room, and the budget
  connectors [room]  List the APIs a room can call (default: the lobby)
  connector share|unshare <id> [room]
                     Share a room's connector, one without a key, with every room, or
                     move a shared one back into the room
  db [encrypt|decrypt|redact]
                     Show whether each database is encrypted, or encrypt or decrypt it in
                     place (stop "nudge serve" first). The key is NUDGE_DB_KEY, or a
                     <database>.key file that "encrypt" writes. "redact" rewrites history
                     from before placeholders were stored, so forgetting a value erases it
  backup             Make an encrypted backup of every assistant now, into --to <dir> or
                     the config's backup.dir; works while "nudge serve" runs
  restore <file>     Unpack a backup into --to <dir> (--force overwrites files there);
                     --kit <file> takes the key from a recovery kit, as on a new machine
  kit [file]         Write a recovery kit: the backup key, sealed with a passphrase
  owner [list|add <player>|remove <id>|token <player>]
                     The server's owners, who create, change and delete assistants and
                     set model keys over /v1/server; token prints one for an owner
  wired [status|on|add <url>|join <invite>]
                     The server's Wired, a network between Nudge servers with no open port at
                     home: on (at home), add a server's https address there for its invite,
                     then join with it on that server (--url, --token: an owner's)
  reload             Read the config again in the running server: new assistants open,
                     removed ones close, changed ones reopen, extensions reinstall
  doctor             Check Node, config, storage and model credentials;
                     --ping sends one request, --privacy tests redaction

The admin commands (invite to connector) open the assistant's database. While "nudge serve"
has it open, they go through the server instead when given an admin's token (--token or
$NUDGE_TOKEN; --url when it isn't on --host and --port). invite and pair then print a
pairing code instead of a token.

Options:
  -c, --config <file>      Config file (default: ./nudge.json if there is one, else the data
                           directory's: $NUDGE_HOME, or ~/.local/share/nudge)
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
      --trust-proxy        serve: behind a proxy that ends TLS, such as exe.dev's, take
                           the address from its X-Forwarded-* headers (NUDGE_TRUST_PROXY=1)
      --remove             admin: take the flag away
      --to <dir>           backup, restore: where to
      --force              restore: overwrite files that are there
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
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
      "trust-proxy": { type: "boolean", default: process.env.NUDGE_TRUST_PROXY === "1" },
      ping: { type: "boolean", default: false },
      privacy: { type: "boolean", default: false },
      remove: { type: "boolean", default: false },
      to: { type: "string" },
      kit: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, argument, ...rest] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  const config = values.config ?? defaultConfigPath();
  const admin = { config, assistant: values.assistant };
  const server = values.url ?? `http://${values.host}:${values.port}`;
  const access = { ...admin, server, token: values.token };
  switch (command) {
    case "init":
    case "setup":
      await setup(config);
      return 0;
    case "chat":
      await chat({ ...values, ...admin, room: argument });
      return 0;
    case "serve": {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new UsageError(`--port ${values.port} is not a port`);
      return await serve({
        config,
        port,
        host: values.host,
        web: values.web,
        publicUrl: values["public-url"],
        trustProxy: values["trust-proxy"],
      });
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
      if (argument === "rename") {
        const [id, ...words] = rest;
        if (id === undefined || words.length === 0)
          throw new UsageError("Usage: nudge room rename <id> <name>");
        await renameRoom({ ...access, room: id, name: words.join(" ") });
        return 0;
      }
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
    case "backup":
      await backup({
        config,
        ...(values.to === undefined ? {} : { to: values.to }),
      });
      return 0;
    case "restore":
      await restore({
        config,
        ...(argument === undefined ? {} : { file: argument }),
        ...(values.to === undefined ? {} : { to: values.to }),
        ...(values.kit === undefined ? {} : { kit: values.kit }),
        force: values.force,
      });
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
      if (
        argument !== undefined &&
        argument !== "encrypt" &&
        argument !== "decrypt" &&
        argument !== "redact"
      )
        throw new UsageError("Usage: nudge db [encrypt|decrypt|redact]");
      await db({ ...admin, verb: argument });
      return 0;
    case "kit":
      await kit(config, argument);
      return 0;
    case "owner":
      await owner({ ...admin, verb: argument, id: rest[0] });
      return 0;
    case "wired":
      await wired({
        ...(values.url === undefined ? {} : { url: values.url }),
        ...(values.token === undefined ? {} : { token: values.token }),
        ...(argument === undefined ? {} : { verb: argument }),
        ...(rest[0] === undefined ? {} : { arg: rest[0] }),
      });
      return 0;
    case "reload":
      return (await reload(admin)) ? 0 : 1;
    case "doctor":
      return (await doctor({ config, ping: values.ping, privacy: values.privacy })) ? 0 : 1;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

const QUIET_ERRORS = new Set([
  "ConfigError",
  "ConfigMissing",
  "UsageError",
  "DatabaseInUse",
  "DatabaseKeyError",
]);

export function run(argv: string[]): void {
  main(argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error && QUIET_ERRORS.has(error.name) ? error.message : error);
      process.exit(1);
    },
  );
}
