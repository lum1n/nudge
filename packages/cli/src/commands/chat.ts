import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Author, findAssistant, loadConfig, openAssistant } from "@nudge/core";
import { ChatRenderer } from "../render.ts";

export type ChatOptions = {
  readonly config: string;
  readonly assistant?: string;
  readonly name?: string;
};

const HELP =
  "Commands: /steer <text> joins the running answer, /stop stops it, " +
  "/private <value> keeps a value from the model, /quit leaves.";

export async function chat(options: ChatOptions): Promise<void> {
  const context = BACKGROUND_CONTEXT;
  const config = await loadConfig(options.config);
  const assistant = findAssistant(config, options.assistant);
  // NUDGE_DEBUG_REQUESTS=1 appends every request, exactly as the provider gets it, next to the database.
  const dump = process.env.NUDGE_DEBUG_REQUESTS
    ? `${assistant.database}.requests.jsonl`
    : undefined;
  const nudge = await openAssistant(config, assistant, context, {
    onReport: (error) => console.error(error),
    privacy: dump
      ? { onRequest: (request) => appendFileSync(dump, `${JSON.stringify(request)}\n`) }
      : undefined,
  });
  if (dump !== undefined) console.log(`Writing requests to ${dump}`);
  const assistantName = assistant.displayName ?? assistant.name;
  const clientId = `cli-${randomUUID()}`;
  const author: Author = {
    playerId: "owner",
    displayName: options.name ?? userInfo().username,
    clientId,
  };
  const roomId = nudge.lobbyId;

  const renderer = new ChatRenderer((text) => process.stdout.write(text), assistantName, clientId);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  console.log(`${assistantName} · ${HELP}\n`);
  const stream = await nudge.attach(roomId, context);
  renderer.history(stream.snapshot);
  stream.start(async (events) => {
    for (const event of events) {
      renderer.event(event);
      if (event.type === "run_end") rl.prompt();
    }
  });

  if (!renderer.busy) rl.prompt();

  let closing = false;
  const quit = async () => {
    if (closing) return;
    closing = true;
    rl.close();
    await stream.stop();
    await nudge.close(context);
  };

  rl.on("SIGINT", () => {
    // Ctrl-C stops a running answer, and leaves when there is none.
    if (renderer.busy) {
      void (async () => (await nudge.harness.conversation(roomId, context))?.abort(context))();
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
    if (line === "/help") {
      console.log(HELP);
      rl.prompt();
      continue;
    }
    if (line === "/stop") {
      await (await nudge.harness.conversation(roomId, context))?.abort(context);
      rl.prompt();
      continue;
    }
    if (line.startsWith("/private ")) {
      const placeholder = await nudge.protect(line.slice("/private ".length));
      console.log(`  The model will see ${placeholder} instead.`);
      rl.prompt();
      continue;
    }
    const steer = line.startsWith("/steer ");
    const text = steer ? line.slice("/steer ".length) : line;
    const submission = await nudge.submit(
      roomId,
      {
        text,
        author,
        requestId: `${clientId}:${randomUUID()}`,
        whenBusy: steer ? "steer" : "followUp",
      },
      context,
    );
    void submission.wait(context).then(
      (settled) => {
        if (settled.status === "unanswered") {
          console.log(`\n  ! not answered: ${settled.reason}${describe(settled.detail)}`);
          rl.prompt();
        }
      },
      () => {},
    );
  }
  await quit();
}

function describe(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  return ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`;
}
