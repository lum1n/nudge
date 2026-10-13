import { parseArgs } from "node:util";
import { chat } from "./commands/chat.ts";
import { doctor } from "./commands/doctor.ts";
import { init } from "./commands/init.ts";

const USAGE = `Usage: nudge <command> [options]

Commands:
  init               Write a nudge.json in this directory
  chat               Chat with an assistant in this terminal
  doctor             Check Node, config, storage and model credentials;
                     --ping sends one request, --privacy tests redaction

Options:
  -c, --config <file>      Config file (default: nudge.json)
  -a, --assistant <name>   Assistant to use (default: the first one)
  -n, --name <name>        Your display name in chat (default: your user name)
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: "nudge.json" },
      assistant: { type: "string", short: "a" },
      name: { type: "string", short: "n" },
      ping: { type: "boolean", default: false },
      privacy: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  switch (command) {
    case "init":
      await init(values.config);
      return 0;
    case "chat":
      await chat({ config: values.config, assistant: values.assistant, name: values.name });
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

export function run(argv: string[]): void {
  main(argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error && error.name === "ConfigError" ? error.message : error);
      process.exit(1);
    },
  );
}
