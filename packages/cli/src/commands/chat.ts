import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { UsageError } from "../errors.ts";
import { ChatRenderer, describeApproval, describeNudge } from "../render.ts";
import { type ChatSession, openLocal, openRemote } from "../session.ts";

export type ChatOptions = {
  readonly config: string;
  readonly assistant?: string;
  /** Room id, or `me` for your personal room. Default: the lobby. */
  readonly room?: string;
  /** In-process: the player to chat as. */
  readonly player?: string;
  readonly name?: string;
  /** Remote: `http(s)://host:port/a/<assistant>`. */
  readonly url?: string;
  readonly token?: string;
};

const HELP =
  "Commands: /steer <text> joins the running answer, /stop stops it, " +
  "/private <value> keeps a value from the model, /who lists who can read along, " +
  "/nudges lists scheduled nudges, /nudges cancel <id> cancels one, " +
  "/memory lists what the assistant remembers here, /memory add <text> and /memory forget <id> " +
  "change it, /approvals lists actions waiting for approval, /approve <id> and /deny <id> " +
  "decide one, /quit leaves.";

export async function chat(options: ChatOptions): Promise<void> {
  let rl: ReturnType<typeof createInterface> | undefined;
  const onProblem = (message: string) => {
    console.log(`\n  ! ${message}`);
    rl?.prompt();
  };
  const session = await open(options, onProblem);
  const { assistantName, room } = session;

  const renderer = new ChatRenderer(
    (text) => process.stdout.write(text),
    assistantName,
    session.clientId,
  );
  rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  const where = room.kind === "lobby" ? "" : ` · ${room.name}`;
  console.log(`${assistantName}${where} · ${HELP}\n`);
  const prompt = rl;
  // Approvals already announced, so each new one is shown once.
  const announced = new Set<string>();
  const announce = async () => {
    const waiting = (await session.approvals()).filter(
      (approval) => approval.status === "pending" && !announced.has(approval.id),
    );
    for (const approval of waiting.reverse()) {
      announced.add(approval.id);
      console.log(
        `  ? ${describeApproval(approval)} — /approve ${approval.id} or /deny ${approval.id}`,
      );
    }
    if (waiting.length > 0) prompt.prompt();
  };
  const snapshot = await session.attach((events) => {
    for (const event of events) {
      renderer.event(event);
      if (event.type === "run_end") {
        prompt.prompt();
        void announce().catch(() => {});
      }
    }
  });
  renderer.history(snapshot);
  await announce().catch(() => {});

  if (!renderer.busy) rl.prompt();

  let closing = false;
  const quit = async () => {
    if (closing) return;
    closing = true;
    prompt.close();
    await session.close();
  };

  rl.on("SIGINT", () => {
    // Ctrl-C stops a running answer, and leaves when there is none.
    if (renderer.busy) {
      void session.abort();
      return;
    }
    void quit();
  });

  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "") {
      rl.prompt();
      continue;
    }
    if (line === "/quit" || line === "/exit") break;
    try {
      if (line === "/help") {
        console.log(HELP);
      } else if (line === "/stop") {
        await session.abort();
      } else if (line === "/who") {
        console.log(`  ${(await session.members()).join(", ")}`);
      } else if (line === "/nudges") {
        const nudges = await session.nudges();
        if (nudges.length === 0) console.log("  No nudges scheduled here.");
        for (const nudge of nudges) console.log(`  ${describeNudge(nudge)}`);
      } else if (line.startsWith("/nudges ")) {
        const id = /^\/nudges cancel\s+(\S+)$/.exec(line)?.[1];
        if (id === undefined) console.log("  Usage: /nudges cancel <id>");
        else
          console.log((await session.cancelNudge(id)) ? "  Cancelled." : `  No nudge ${id} here.`);
      } else if (line === "/memory") {
        const facts = await session.memory();
        if (facts.length === 0) console.log("  Nothing remembered here.");
        for (const fact of facts) console.log(`  ${fact.id}: ${fact.text}`);
      } else if (line.startsWith("/memory ")) {
        const [, verb, rest] = /^\/memory\s+(add|forget)\s+(.+)$/.exec(line) ?? [];
        if (verb === "add") console.log(`  Remembered ${(await session.remember(rest!)).id}.`);
        else if (verb === "forget")
          console.log(
            (await session.forget(rest!.trim())) ? "  Forgotten." : `  No fact ${rest} here.`,
          );
        else console.log("  Usage: /memory add <text> | /memory forget <id>");
      } else if (line === "/approvals") {
        const approvals = await session.approvals();
        if (approvals.length === 0) console.log("  Nothing to approve here.");
        for (const approval of approvals) console.log(`  ${describeApproval(approval)}`);
      } else if (/^\/(approve|deny)(\s|$)/.test(line)) {
        const [, verb, id] = /^\/(approve|deny)\s+(\S+)$/.exec(line) ?? [];
        if (id === undefined) console.log("  Usage: /approve <id> | /deny <id>");
        else {
          const decided = await session.decide(id, verb === "approve");
          console.log(`  ${describeApproval(decided)}`);
        }
      } else if (line.startsWith("/private ")) {
        const placeholder = await session.protect(line.slice("/private ".length));
        console.log(`  The model will see ${placeholder} instead.`);
      } else {
        const steer = line.startsWith("/steer ");
        await session.submit(
          steer ? line.slice("/steer ".length) : line,
          steer ? "steer" : "followUp",
        );
        continue;
      }
    } catch (error) {
      console.log(`  ! ${(error as Error).message}`);
    }
    rl.prompt();
  }
  await quit();
}

function open(options: ChatOptions, onProblem: (message: string) => void): Promise<ChatSession> {
  if (options.url !== undefined) {
    if (options.token === undefined)
      throw new UsageError("Connecting to a server needs a token: set NUDGE_TOKEN or pass --token");
    return openRemote({ url: options.url, token: options.token, room: options.room, onProblem });
  }
  return openLocal({
    config: options.config,
    assistant: options.assistant,
    player: options.player,
    name: options.name,
    defaultName: userInfo().username,
    room: options.room,
    onProblem,
  });
}
