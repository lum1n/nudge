// A Nudge server on a faux model, for testing clients in other languages (`clients/`): one
// assistant "robin" with players Ann (the admin) and Bo and their shared room "trip".
// Runs the built packages, so `pnpm build` first: `node packages/server/scripts/faux-server.ts`.
// Prints one JSON line, `{ url, assistant, tokens: { ann, bo }, pairing: { bo, ann } }` (pairing
// codes good for 10 minutes), and stops when stdin ends. The rooms have the lists, documents and
// connectors extensions, for clients' panels, and the admin's extension settings work: saving
// installs the extensions again. The mail extension is listed as one nobody added yet.
//
// The database and the extensions' files are kept in a temporary directory, removed on exit, or
// in `NUDGE_FAUX_DATA` when that is set. `NUDGE_FAUX_BROWSER=1` adds the browser extension, headless
// and driven by the faux model, for the live view (it needs Chromium: `npx patchright install`).
//
// The model answers "Hello! …" in several pieces first and "Answer <n>." after that. A message
// containing "please pay" makes it call `pay`, which waits for an approval and answers "Paid 10 kr.";
// one containing "remind me" makes it schedule the nudge "Water the plants" an hour ahead; "add a
// connector" makes it ask to add the connector "Weather", which takes an API key; and with the
// browser, "log me in" makes it browse, and the browser ask for a login on example.com.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  ConfigError,
  createNudge,
  defineNudgeExtension,
  defineTool,
  type ExtensionUse,
  type NudgeExtension,
  requestApproval,
  roomOf,
  type RoomKind,
  Type,
} from "@nudge/core";
import browserExtension, { closeAllBrowsers } from "@nudge/ext-browser";
import connectorsExtension from "@nudge/ext-connectors";
import { documentsExtension } from "@nudge/ext-documents";
import { listsExtension } from "@nudge/ext-lists";
import mailExtension from "@nudge/ext-mail";
import type { ExtensionSetup } from "@nudge/protocol";
import { type ExtensionSettings, serveNudge } from "@nudge/server";

const context = BACKGROUND_CONTEXT;
const withBrowser = process.env.NUDGE_FAUX_BROWSER === "1";
/** Typed by the faux model as the browser's task, so its requests can be told apart. */
const BROWSER_TASK = "Read the inbox on example.com";

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
  // The browser agent's first request: the site wants a login.
  if (text === BROWSER_TASK)
    return fauxAssistantMessage(
      [
        fauxToolCall("browser_request_login", {
          site: "example.com",
          reason: "The inbox needs a login",
        }),
      ],
      { stopReason: "toolUse" },
    );
  if (/please pay/i.test(text))
    return fauxAssistantMessage([fauxToolCall("pay", { amount: 10 })], { stopReason: "toolUse" });
  if (/remind me/i.test(text))
    return fauxAssistantMessage(
      [fauxToolCall("schedule_nudge", { message: "Water the plants", in_minutes: 60 })],
      { stopReason: "toolUse" },
    );
  if (/add a connector/i.test(text))
    return fauxAssistantMessage(
      [
        fauxToolCall("add_connector", {
          name: "Weather",
          baseUrl: "https://api.weather.example",
          useFor: "Forecasts for any town",
          auth: { in: "header", name: "X-Api-Key" },
        }),
      ],
      { stopReason: "toolUse" },
    );
  if (withBrowser && /log me in/i.test(text))
    return fauxAssistantMessage([fauxToolCall("browse", { task: BROWSER_TASK })], {
      stopReason: "toolUse",
    });
  const n = answers++;
  return fauxAssistantMessage(
    n === 0 ? `Hello! ${"This answer arrives in several pieces. ".repeat(8)}` : `Answer ${n - 1}.`,
  );
};
const faux = fauxProvider({ tokensPerSecond: 200 });
faux.setResponses(Array.from({ length: 1000 }, () => respond));
const models = createModels();
models.setProvider(faux.provider);

/** The extensions the settings routes know, as if found in the config beside `nudge.json`. */
type Setup = {
  readonly from: string;
  readonly extension: NudgeExtension;
  configured: boolean;
  enabled: boolean;
  settings: Record<string, unknown>;
  rooms?: RoomKind[];
};
const setups: Setup[] = [
  { from: "./payer.ts", extension: payer, configured: true, enabled: true, settings: {} },
  {
    from: "@nudge/ext-lists",
    extension: listsExtension,
    configured: true,
    enabled: true,
    settings: {},
  },
  {
    from: "@nudge/ext-documents",
    extension: documentsExtension,
    configured: true,
    enabled: true,
    settings: {},
  },
  {
    from: "@nudge/ext-connectors",
    extension: connectorsExtension,
    configured: true,
    enabled: true,
    settings: {},
  },
  {
    from: "@nudge/ext-browser",
    extension: browserExtension,
    configured: withBrowser,
    enabled: withBrowser,
    settings: withBrowser
      ? { model: `${faux.provider.id}/${faux.getModel().id}`, headless: true }
      : {},
  },
  {
    from: "@nudge/ext-mail",
    extension: mailExtension,
    configured: false,
    enabled: false,
    settings: {},
  },
];
const installed = (): ExtensionUse[] =>
  setups
    .filter((setup) => setup.enabled)
    .map(({ extension, settings, rooms }) => ({
      extension,
      settings,
      ...(rooms === undefined ? {} : { rooms }),
    }));

// Temporary directories of earlier runs that were killed, rather than stopped, go first.
const temporary = process.env.NUDGE_FAUX_DATA === undefined;
for (const name of temporary ? readdirSync(tmpdir()) : []) {
  const pid = /^nudge-faux-(\d+)-/.exec(name)?.[1];
  if (pid === undefined) continue;
  try {
    process.kill(Number(pid), 0);
  } catch {
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
}
const dataDir = temporary
  ? mkdtempSync(join(tmpdir(), `nudge-faux-${process.pid}-`))
  : process.env.NUDGE_FAUX_DATA!;
mkdirSync(dataDir, { recursive: true });
const removeData = () => {
  if (temporary) rmSync(dataDir, { recursive: true, force: true });
};

const nudge = await createNudge(
  {
    database: join(dataDir, "robin.sqlite"),
    models,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    settings: { progress: { partialIntervalMs: 20 } },
    extensions: installed(),
  },
  context,
);

const listSetups = async (): Promise<ExtensionSetup[]> =>
  setups.map((setup) => ({
    from: setup.from,
    name: setup.extension.name,
    ...(setup.extension.version === undefined ? {} : { version: setup.extension.version }),
    ...(setup.extension.description === undefined
      ? {}
      : { description: setup.extension.description }),
    configured: setup.configured,
    enabled: setup.enabled,
    ...(setup.rooms === undefined ? {} : { rooms: setup.rooms }),
    settings: setup.settings,
    ...(setup.extension.settings === undefined ? {} : { schema: setup.extension.settings }),
    missingEnv: [...JSON.stringify(setup.settings).matchAll(/\$\{([A-Z0-9_]+)\}/g)]
      .map((match) => match[1]!)
      .filter((name) => process.env[name] === undefined),
  }));

const extensionSettings: ExtensionSettings = {
  list: listSetups,
  save: async (_assistant, extensions) => {
    const unknown = extensions.find((e) => !setups.some((setup) => setup.from === e.from));
    if (unknown !== undefined) throw new ConfigError(`No extension ${unknown.from} here`);
    const before = setups.map((setup) => ({ ...setup }));
    for (const setup of setups) {
      const saved = extensions.find((e) => e.from === setup.from);
      setup.configured = saved !== undefined;
      setup.enabled = saved?.enabled ?? false;
      setup.settings = saved?.settings ?? {};
      if (saved?.rooms === undefined) delete setup.rooms;
      else setup.rooms = [...saved.rooms];
    }
    try {
      await nudge.reloadExtensions(installed());
    } catch (error) {
      setups.splice(0, setups.length, ...before);
      throw error instanceof ConfigError
        ? error
        : new ConfigError(`Nothing changed: ${(error as Error).message}`);
    }
    return listSetups();
  },
};

const ann = (await nudge.players.invite("Ann", context)).token;
const bo = (await nudge.players.invite("Bo", context)).token;
await nudge.rooms.createShared({ id: "trip", name: "Trip", members: ["ann", "bo"] }, context);
const port = Number(process.env.NUDGE_FAUX_PORT ?? 0);
const server = await serveNudge({
  assistants: new Map([["robin", nudge]]),
  port,
  extensionSettings,
});
const pairing = {
  bo: (await nudge.players.pairingCode("bo", context)).code,
  ann: (await nudge.players.pairingCode("ann", context)).code,
};
process.stdout.write(
  `${JSON.stringify({ url: server.url, assistant: "robin", tokens: { ann, bo }, pairing })}\n`,
);

const stop = () => {
  void server
    .close()
    .then(() => nudge.close(context))
    .then(() => (withBrowser ? closeAllBrowsers() : undefined))
    .finally(() => {
      removeData();
      process.exit(0);
    });
};
process.stdin.resume();
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
