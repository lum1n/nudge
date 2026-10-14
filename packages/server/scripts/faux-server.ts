// A Nudge server on a faux model, for testing clients in other languages (`clients/`): one
// assistant "robin" with players Ann (the admin) and Bo and their shared room "trip", in memory.
// Runs the built packages, so `pnpm build` first: `node packages/server/scripts/faux-server.ts`.
// Prints one JSON line, `{ url, assistant, tokens: { ann, bo } }`, and stops when stdin ends.
//
// The model answers "Hello! …" in several pieces first and "Answer <n>." after that. A message
// containing "please pay" makes it call `pay`, which waits for an approval and answers "Paid 10 kr.";
// one containing "remind me" makes it schedule the nudge "Water the plants" an hour ahead.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createNudge,
  defineNudgeExtension,
  defineTool,
  requestApproval,
  roomOf,
  Type,
} from "@nudge/core";
import { serveNudge } from "@nudge/server";

const context = BACKGROUND_CONTEXT;

const payer = defineNudgeExtension({
  name: "payer",
  version: "1",
  setup: () => ({
    tools: [
      defineTool({
        name: "pay",
        description: "Pay an amount, once someone approves.",
        parameters: Type.Object({ amount: Type.Number() }),
        execute: async (args, api, context) => {
          const room = await roomOf(api, api.conversationId, context);
          const approval = await api.commit(
            (tx) =>
              requestApproval(
                tx,
                room.id,
                {
                  extension: "payer",
                  kind: "pay",
                  summary: `Pay ${args.amount} kr`,
                  payload: { amount: args.amount },
                },
                Date.now(),
              ),
            context,
          );
          return { output: [{ type: "text", text: `Waiting for approval ${approval.id}.` }] };
        },
      }),
    ],
    approvals: {
      pay: async (payload) => ({ text: `Paid ${(payload as { amount: number }).amount} kr.` }),
    },
  }),
});

let answers = 0;
const respond: FauxResponseFactory = (request) => {
  const last = request.messages.at(-1);
  const text =
    last?.role !== "user"
      ? ""
      : typeof last.content === "string"
        ? last.content
        : last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  if (/please pay/i.test(text))
    return fauxAssistantMessage([fauxToolCall("pay", { amount: 10 })], { stopReason: "toolUse" });
  if (/remind me/i.test(text))
    return fauxAssistantMessage(
      [fauxToolCall("schedule_nudge", { message: "Water the plants", in_minutes: 60 })],
      { stopReason: "toolUse" },
    );
  const n = answers++;
  return fauxAssistantMessage(
    n === 0 ? `Hello! ${"This answer arrives in several pieces. ".repeat(8)}` : `Answer ${n - 1}.`,
  );
};
const faux = fauxProvider({ tokensPerSecond: 200 });
faux.setResponses(Array.from({ length: 1000 }, () => respond));
const models = createModels();
models.setProvider(faux.provider);
const nudge = await createNudge(
  {
    database: ":memory:",
    models,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    settings: { progress: { partialIntervalMs: 20 } },
    extensions: [payer],
  },
  context,
);
const ann = (await nudge.players.invite("Ann", context)).token;
const bo = (await nudge.players.invite("Bo", context)).token;
await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
const port = Number(process.env.NUDGE_FAUX_PORT ?? 0);
const server = await serveNudge({ assistants: new Map([["robin", nudge]]), port });
process.stdout.write(
  `${JSON.stringify({ url: server.url, assistant: "robin", tokens: { ann, bo } })}\n`,
);

process.stdin.resume();
process.stdin.on("end", () => {
  void server
    .close()
    .then(() => nudge.close(context))
    .then(() => process.exit(0));
});
