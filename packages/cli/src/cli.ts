import { parseArgs } from "node:util";
import { invite, nudges, room } from "./commands/admin.ts";
import { chat } from "./commands/chat.ts";
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
  room [name]        Create a shared room with --members, or list the rooms
  nudges             List the scheduled nudges of every room
  doctor             Check Node, config, storage and model credentials;
                     --ping sends one request, --privacy tests redaction

invite, room and nudges open the assistant's database, so stop "nudge serve" first.

Options:
  -c, --config <file>      Config file (default: nudge.json)
  -a, --assistant <name>   Assistant to use (default: the first one)
  -n, --name <name>        Your display name in chat
  -p, --player <id>        Chat in this process as this player (default: owner)
  -m, --members <ids>      Comma-separated player ids for a new room
  -u, --url <url>          Chat through a server: http://host:port/a/<assistant>
  -t, --token <token>      Token for --url (default: $NUDGE_TOKEN)
      --port <port>        serve: port (default: 8787)
      --host <host>        serve: interface (default: 127.0.0.1)
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
      ping: { type: "boolean", default: false },
      privacy: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, argument] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  const admin = { config: values.config, assistant: values.assistant };
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
      await serve({ config: values.config, port, host: values.host });
      return 0;
    }
    case "invite":
      if (argument === undefined) throw new UsageError("invite needs a name: nudge invite <name>");
      await invite({ ...admin, name: argument });
      return 0;
    case "room": {
      const members = values.members
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "");
      await room({ ...admin, name: argument, members });
      return 0;
    }
    case "nudges":
      await nudges(admin);
      return 0;
    case "doctor":
      return (await doctor({ config: values.config, ping: values.ping, privacy: values.privacy }))
        ? 0
        : 1;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

const QUIET_ERRORS = new Set(["ConfigError", "UsageError", "DatabaseInUse"]);

export function run(argv: string[]): void {
  main(argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error && QUIET_ERRORS.has(error.name) ? error.message : error);
      process.exit(1);
    },
  );
}
