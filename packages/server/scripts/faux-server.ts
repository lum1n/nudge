// A Nudge server on a faux model, for testing clients in other languages (`clients/`): one
// assistant "robin" with players Ann (the admin) and Bo and their shared room "trip", in memory.
// Runs the built packages, so `pnpm build` first: `node packages/server/scripts/faux-server.ts`.
// Prints one JSON line, `{ url, assistant, tokens: { ann, bo } }`, and stops when stdin ends.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge } from "@nudge/core";
import { serveNudge } from "@nudge/server";

const context = BACKGROUND_CONTEXT;
const faux = fauxProvider({ tokensPerSecond: 200 });
faux.setResponses([
  fauxAssistantMessage(`Hello! ${"This answer arrives in several pieces. ".repeat(8)}`),
  ...Array.from({ length: 500 }, (_, n) => fauxAssistantMessage(`Answer ${n}.`)),
]);
const models = createModels();
models.setProvider(faux.provider);
const nudge = await createNudge(
  {
    database: ":memory:",
    models,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    settings: { progress: { partialIntervalMs: 20 } },
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
