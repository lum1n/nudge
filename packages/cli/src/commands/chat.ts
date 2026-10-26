import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { UsageError } from "../errors.ts";
import type { ExtensionChannel } from "../extension-channel.ts";
import {
  ChatRenderer,
  type Connector,
  describeApproval,
  describeConnector,
  describeExtension,
  describeNudge,
} from "../render.ts";
import type { RoomView } from "@nudge/protocol";
import { type ChatSession, openLocal, openRemote } from "../session.ts";

export type ChatOptions = {
  readonly config: string;
  readonly assistant?: string;
  /** Room id, or `me` for your personal room. Default: the lobby. */
  readonly room?: string;
  /** In-process: the player to chat as. */
  readonly player?: string;
  readonly name?: string;
  /** Remote: `http(s)://host:port`; `assistant` picks one there. */
  readonly url?: string;
  readonly token?: string;
};

const HELP =
  "Commands: /steer <text> joins the running answer, /stop stops it, " +
  "/private <value> keeps a value from the model and from everyone but you, /hidden lists " +
  "those values and /hidden forget <placeholder> drops one for good, /whisper <text> sends a " +
  "message only you see, and the answer to it, /who lists who can read along, " +
  "/nudges lists scheduled nudges, /nudges cancel <id> cancels one, " +
  "/memory lists what the assistant remembers here, /memory add <text> and /memory forget <id> " +
  "change it, /approvals lists actions waiting for approval, /approve <id> and /deny <id> " +
  "decide one, /extensions lists the extensions and whether they are on here, " +
  "/extensions on|off|default <name> changes one, /connectors lists the APIs this room can " +
  "call, /connector-key <id> sets one's API key, /connector-first <id> on|off [use for] has " +
  "the assistant try one first, before anything else, for what it's for, /quit leaves.";

export async function chat(options: ChatOptions): Promise<void> {
  let rl: ReturnType<typeof createInterface> | undefined;
  // Input can end while a command still runs, as when it is piped in.
  let inputEnded = false;
  const ask = () => {
    if (!inputEnded) rl?.prompt();
  };
  const onProblem = (message: string) => {
    console.log(`\n  ! ${message}`);
    ask();
  };
  const session = await open(options, onProblem);
  const { assistantName } = session;

  const renderer = new ChatRenderer(
    (text) => process.stdout.write(text),
    assistantName,
    session.clientId,
  );
  rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.on("close", () => (inputEnded = true));
  // Readline drops lines, and its close, that come before the iterator exists; piped input can
  // all arrive while the room is still loading.
  const lines = rl[Symbol.asyncIterator]();
  const prompt = rl;
  // Approvals already announced, so each new one is shown once.
  const announced = new Set<string>();
  const announce = (view: RoomView) => {
    const waiting = view.approvals.filter(
      (approval) => approval.status === "pending" && !announced.has(approval.id),
    );
    for (const approval of waiting.reverse()) {
      announced.add(approval.id);
      console.log(
        `  ? ${describeApproval(approval)} — /approve ${approval.id} or /deny ${approval.id}`,
      );
    }
    return waiting.length > 0;
  };
  // Views that arrive before the history is on screen only update `latest`.
  let latest: RoomView | undefined;
  let started = false;
  const waiting = new Set<() => void>();
  const first = await session.watch((next) => {
    latest = next;
    for (const check of waiting) check();
    if (!started) return;
    const ended = renderer.update(next);
    if (announce(next) || ended) ask();
  });
  const { room } = first;
  const where = room.kind === "lobby" ? "" : ` · ${room.name}`;
  console.log(`${assistantName}${where} · ${HELP}\n`);
  latest ??= first;
  renderer.history(latest);
  announce(latest);
  started = true;
  const now = () => latest ?? first;
  /**
   * Settles once the view shows what a command changed, or after two seconds, so a list asked
   * for right after the change has it.
   */
  const shown = (done: (view: RoomView) => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (!done(now())) return;
        clearTimeout(timer);
        waiting.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        waiting.delete(check);
        resolve();
      }, 2000);
      waiting.add(check);
      check();
    });

  if (!renderer.busy) ask();

  // The connectors extension's panel, opened on first use.
  let connectors: Promise<ExtensionChannel> | undefined;
  const panel = () => {
    connectors ??= session.extension("connectors");
    connectors.catch(() => (connectors = undefined));
    return connectors;
  };
  const listConnectors = async (channel: ExtensionChannel) =>
    (await channel.latest<{ type: string; connectors: Connector[] }>("connectors")).connectors;
  /** Reads the next line without echoing it, for keys; empty when input ended. */
  const askSecret = async (question: string): Promise<string> => {
    const output = prompt as unknown as { _writeToOutput(text: string): void };
    const write = output._writeToOutput;
    output._writeToOutput = () => {};
    process.stdout.write(question);
    try {
      const next = await lines.next();
      return next.done === true ? "" : next.value;
    } finally {
      output._writeToOutput = write;
      if (process.stdin.isTTY) process.stdout.write("\n");
    }
  };

  let closing = false;
  const quit = async () => {
    if (closing) return;
    closing = true;
    prompt.close();
    (await connectors?.catch(() => undefined))?.close();
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

  for await (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      ask();
      continue;
    }
    if (line === "/quit" || line === "/exit") break;
    try {
      if (line === "/help") {
        console.log(HELP);
      } else if (line === "/stop") {
        await session.abort();
      } else if (line === "/who") {
        const members = now().room.members.map((player) => player.displayName);
        console.log(`  ${room.kind === "lobby" ? "Everyone" : members.join(", ")}`);
      } else if (line === "/nudges") {
        if (now().nudges.length === 0) console.log("  No nudges scheduled here.");
        for (const nudge of now().nudges) console.log(`  ${describeNudge(nudge)}`);
      } else if (line.startsWith("/nudges ")) {
        const id = /^\/nudges cancel\s+(\S+)$/.exec(line)?.[1];
        if (id === undefined) console.log("  Usage: /nudges cancel <id>");
        else {
          await session.cancelNudge(id);
          await shown((view) => !view.nudges.some((nudge) => nudge.id === id));
          console.log("  Cancelled.");
        }
      } else if (line === "/memory") {
        if (now().memory.length === 0) console.log("  Nothing remembered here.");
        for (const fact of now().memory) console.log(`  ${fact.id}: ${fact.text}`);
      } else if (line.startsWith("/memory ")) {
        const [, verb, rest] = /^\/memory\s+(add|forget)\s+(.+)$/.exec(line) ?? [];
        if (verb === "add") {
          const { id } = await session.remember(rest!);
          await shown((view) => view.memory.some((fact) => fact.id === id));
          console.log(`  Remembered ${id}.`);
        } else if (verb === "forget") {
          const id = rest!.trim();
          await session.forget(id);
          await shown((view) => !view.memory.some((fact) => fact.id === id));
          console.log("  Forgotten.");
        } else console.log("  Usage: /memory add <text> | /memory forget <id>");
      } else if (line === "/approvals") {
        if (now().approvals.length === 0) console.log("  Nothing to approve here.");
        for (const approval of now().approvals) console.log(`  ${describeApproval(approval)}`);
      } else if (/^\/(approve|deny)(\s|$)/.test(line)) {
        const [, verb, id] = /^\/(approve|deny)\s+(\S+)$/.exec(line) ?? [];
        const asked = now().approvals.find((approval) => approval.id === id);
        if (id === undefined) console.log("  Usage: /approve <id> | /deny <id>");
        else if (verb === "approve" && asked?.clientAction !== undefined)
          console.log(`  ${id} runs on your phone: approve it in the Nudge app.`);
        else if (verb === "approve" && (asked?.inputs?.length ?? 0) > 0)
          console.log(
            `  ${id} asks for something to type in: approve it in the app or on the web.`,
          );
        else {
          const decided = await session.decide(id, verb === "approve");
          await shown((view) =>
            view.approvals.some((approval) => approval.id === id && approval.status !== "pending"),
          );
          console.log(`  ${describeApproval(decided)}`);
        }
      } else if (line === "/extensions") {
        const extensions = await session.extensions();
        if (extensions.length === 0) console.log("  No extensions installed.");
        for (const extension of extensions) console.log(`  ${describeExtension(extension)}`);
      } else if (line.startsWith("/extensions ")) {
        const [, verb, name] = /^\/extensions\s+(on|off|default)\s+(\S+)$/.exec(line) ?? [];
        if (name === undefined) console.log("  Usage: /extensions on|off|default <name>");
        else {
          const enabled = verb === "default" ? undefined : verb === "on";
          console.log(`  ${describeExtension(await session.setExtension(name, enabled))}`);
        }
      } else if (line === "/connectors") {
        const list = await listConnectors(await panel());
        if (list.length === 0) console.log("  No connectors here. Ask the assistant to add one.");
        for (const connector of list) console.log(`  ${describeConnector(connector)}`);
      } else if (/^\/connector-key(\s|$)/.test(line)) {
        const id = /^\/connector-key\s+(\S+)$/.exec(line)?.[1];
        if (id === undefined)
          console.log("  Usage: /connector-key <id>, with an id from /connectors");
        else {
          const channel = await panel();
          const connector = (await listConnectors(channel)).find((c) => c.id === id);
          if (connector === undefined) console.log(`  No connector ${id} here.`);
          else {
            const key = (
              await askSecret(`  API key for ${connector.name} (empty clears it): `)
            ).trim();
            await channel.request(
              key === ""
                ? { type: "clearKey", connector: id }
                : { type: "setKey", connector: id, value: key },
            );
            console.log(key === "" ? "  Cleared." : "  Saved. The assistant never sees it.");
          }
        }
      } else if (/^\/connector-first(\s|$)/.test(line)) {
        const [, id, verb, useFor] =
          /^\/connector-first\s+(\S+)\s+(on|off)(?:\s+(.+))?$/.exec(line) ?? [];
        if (id === undefined)
          console.log("  Usage: /connector-first <id> on|off [what to use it for]");
        else {
          const channel = await panel();
          if (useFor !== undefined)
            await channel.request({ type: "setUseFor", connector: id, useFor });
          await channel.request({
            type: "setAlwaysFirst",
            connector: id,
            alwaysFirst: verb === "on",
          });
          const connector = (await listConnectors(channel)).find((c) => c.id === id);
          console.log(
            connector === undefined
              ? "  Saved."
              : verb === "on"
                ? `  The assistant now tries ${connector.name} first for: ${connector.useFor}`
                : `  ${connector.name} no longer comes first.`,
          );
        }
      } else if (line.startsWith("/private ")) {
        const placeholder = await session.protect(line.slice("/private ".length));
        console.log(`  The model and everyone else will see ${placeholder} instead.`);
      } else if (line === "/hidden") {
        const values = await session.privateValues();
        if (values.length === 0) console.log("  No values only you see.");
        for (const value of values) console.log(`  ${value.placeholder} ${value.value}`);
      } else if (line.startsWith("/hidden ")) {
        const placeholder = /^\/hidden\s+forget\s+(\S+)$/.exec(line)?.[1];
        if (placeholder === undefined) console.log("  Usage: /hidden forget <placeholder>");
        else {
          await session.forgetValue(placeholder);
          console.log(`  Forgotten: everyone now sees only ${placeholder}.`);
        }
      } else if (line.startsWith("/whisper ")) {
        await session.send(line.slice("/whisper ".length), "followUp", true);
      } else {
        const steer = line.startsWith("/steer ");
        await session.send(
          steer ? line.slice("/steer ".length) : line,
          steer ? "steer" : "followUp",
        );
        continue;
      }
    } catch (error) {
      console.log(`  ! ${(error as Error).message}`);
    }
    ask();
  }
  await quit();
}

function open(options: ChatOptions, onProblem: (message: string) => void): Promise<ChatSession> {
  if (options.url !== undefined) {
    if (options.token === undefined)
      throw new UsageError("Connecting to a server needs a token: set NUDGE_TOKEN or pass --token");
    return openRemote({
      url: options.url,
      assistant: options.assistant,
      token: options.token,
      room: options.room,
      onProblem,
    });
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
