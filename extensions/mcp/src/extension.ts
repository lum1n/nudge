import { join } from "node:path";
import {
  type Context,
  createToolSearchTool,
  currentTurn,
  defineNudgeExtension,
  defineTool,
  type DocumentReader,
  type ExtensionParts,
  requestApproval,
  returnsUntrusted,
  roomOf,
  section,
  type ToolRegistration,
  Type,
} from "@nudge/core";
import { type CallToolResult, toLlmContent, type Tool } from "@nudge/core/mcp";
import { OAuthLogins } from "./oauth.ts";
import { Panels } from "./panel.ts";
import { McpPool, type ServerConfig } from "./pool.ts";
import { PANEL, RoomServers } from "./room-servers.ts";
import {
  addServer,
  checkDraft,
  describeServer,
  removeServer,
  type RoomServer,
  RoomServersDoc,
  type ServerDraft,
} from "./rooms.ts";

const VERSION = "0.1.0";

const ServerSettings = Type.Object({
  command: Type.Optional(
    Type.String({
      minLength: 1,
      description: "The program to start for a local server; give either this or a URL.",
    }),
  ),
  args: Type.Optional(
    Type.Array(Type.String(), { description: "Arguments passed to the program." }),
  ),
  /** Values may name host variables as `${NAME}`, so keys stay out of nudge.json. */
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      title: "Environment",
      description:
        "Environment variables for the program; a value of ${NAME} takes it from the host's environment.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      title: "Working directory",
      description:
        "The folder the program starts in; in the sandbox, it may read and write it. Its own home when left out.",
    }),
  ),
  /**
   * Run the program in a bubblewrap sandbox (the default), which shows it the system, its own home
   * and working directory, and none of Nudge's files. Off runs it as Nudge's user, able to read
   * Nudge's database and keys.
   */
  sandbox: Type.Optional(
    Type.Boolean({
      description:
        "Run the program in a bubblewrap sandbox without Nudge's files (the default). Off runs it as Nudge's user, able to read Nudge's database and keys.",
    }),
  ),
  url: Type.Optional(
    Type.String({
      minLength: 1,
      title: "URL",
      description: "The address of a remote server; give either this or a command.",
    }),
  ),
  /** Values may name host variables as `${NAME}`. */
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "HTTP headers sent to a remote server; a value of ${NAME} takes it from the host's environment.",
    }),
  ),
  /** Only these of the server's tools; default all. */
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Offer only these of the server's tools; leave empty for all of them.",
    }),
  ),
  /**
   * Which calls wait for someone in the room to approve: `writes` (the default) all but the tools
   * the server marks read-only, once `trustReadOnlyHint` is on, `always` every one, `never` none.
   */
  approval: Type.Optional(
    Type.Union([Type.Literal("writes"), Type.Literal("always"), Type.Literal("never")], {
      description:
        "Which calls wait for someone in the room to approve: writes (all but read-only tools, the default), always or never.",
    }),
  ),
  /**
   * Whether tools the server marks read-only skip approval under `writes`. Off by default: the
   * server sets the mark itself, so with it on, the server decides which of its calls are asked.
   */
  trustReadOnlyHint: Type.Optional(
    Type.Boolean({
      title: "Trust read-only marks",
      description:
        "Let tools the server marks read-only run without approval under writes. Off by default: " +
        "the server sets the mark itself, so until this is on, every call is approved.",
    }),
  ),
  /**
   * Pass images in the server's results to the model as they are. Off by default: redaction reads
   * only text, so whatever a picture shows (names, numbers, faces) reaches the model's provider.
   */
  unredactedImages: Type.Optional(
    Type.Boolean({
      title: "Unredacted images",
      description:
        "Pass images in the server's results to the model. Off by default: only text is redacted, " +
        "so whatever a picture shows reaches the model's provider as it is.",
    }),
  ),
  /** The old name of `unredactedImages`, still read; `unredactedImages` wins when both are set. */
  images: Type.Optional(
    Type.Boolean({
      description: "The old name of unredactedImages, still read; prefer unredactedImages.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Seconds to wait for the server to answer a request; 60 when left out.",
    }),
  ),
});

type ImageSettings = { readonly unredactedImages?: boolean; readonly images?: boolean };

/** Whether a configured server's images reach the model; only an explicit opt-in turns it on. */
export function passesImages(server: ImageSettings): boolean {
  return (server.unredactedImages ?? server.images) === true;
}

/**
 * Servers rooms add never pass images: the model proposes them, and a room has no setting that lets
 * images skip redaction. Their images reach the model as a line of text.
 */
export const ROOM_SERVER_IMAGES = false;

/** A warning for each configured server whose images reach the model unredacted, for doctor. */
export function imageWarnings(servers: Readonly<Record<string, ImageSettings>>): string[] {
  return Object.entries(servers)
    .filter(([, server]) => passesImages(server))
    .map(
      ([name, server]) =>
        `server ${name} passes images to the model unredacted; redaction reads only text, so ` +
        "whatever its pictures show reaches the model's provider" +
        (server.unredactedImages === undefined
          ? " (set by the old images key; rename it unredactedImages)"
          : ""),
    );
}

/** Providers allow at most 64 characters of `[A-Za-z0-9_-]` in a tool name. */
export function toolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** `${NAME}` replaced from `env`; throws naming the first variable that is not set. */
export function fillVariables(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const filled = env[name];
    if (filled === undefined) throw new Error(`$${name} is not set`);
    return filled;
  });
}

/** A warning for each configured program that runs outside the sandbox, for doctor. */
export function sandboxWarnings(
  servers: Readonly<Record<string, { readonly command?: string; readonly sandbox?: boolean }>>,
): string[] {
  return Object.entries(servers)
    .filter(([, server]) => server.command !== undefined && server.sandbox === false)
    .map(
      ([name]) =>
        `server ${name} runs its program without a sandbox, as Nudge's user, so it can read ` +
        "Nudge's database and keys",
    );
}

type Approving = {
  readonly approval: "writes" | "always" | "never";
  readonly trustReadOnlyHint?: boolean;
};

/**
 * Whether a call to `tool` waits for approval. Under `writes`, only a tool the server marks
 * read-only skips it, and only where the server's settings trust that mark.
 */
export function needsApproval(server: Approving, tool: Pick<Tool, "annotations">): boolean {
  if (server.approval === "never") return false;
  if (server.approval === "always") return true;
  return server.trustReadOnlyHint !== true || tool.annotations?.readOnlyHint !== true;
}

type Server = Approving & {
  readonly name: string;
  readonly config: ServerConfig;
  readonly images: boolean;
  readonly tools: readonly Tool[];
};

/**
 * MCP servers' tools for the model. Each tool is `mcp__<server>__<tool>`, deferred, so the model
 * finds the ones it needs with `tool_search` instead of being offered them all. Calls that change
 * things wait for an approval. Results reach the model through the assistant's redaction like any
 * other tool output; images only where a server's settings opt in with `unredactedImages`, since
 * redaction doesn't read them.
 */
export default defineNudgeExtension({
  name: "mcp",
  version: VERSION,
  apiVersion: "1.0",
  description:
    "Tools from MCP servers, found with tool_search; calls that change things are approved",
  settings: Type.Object({
    servers: Type.Record(Type.String(), ServerSettings, {
      default: {},
      description:
        "The MCP servers to use, by name in lowercase letters, digits, - and _; the name becomes part of each tool's name.",
    }),
    /** Close a server's connection, and stop a started program, after this long unused. */
    /** For started programs in the sandbox, configured and added by rooms. */
    readable: Type.Array(Type.String(), {
      default: [],
      description:
        "More directories MCP servers' programs may read in the sandbox, at the same paths, such as where node or uv is installed outside /usr and /opt.",
    }),
    idleMinutes: Type.Number({
      default: 5,
      minimum: 0,
      description: "Minutes unused before a server's connection is closed and its program stopped.",
    }),
  }),
  setup: async ({
    settings,
    now,
    name: assistant,
    secrets,
    dataDir,
    documents,
  }): Promise<ExtensionParts> => {
    const configs = new Map<string, ServerConfig>();
    const failed: string[] = [];
    for (const [name, server] of Object.entries(settings.servers)) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name))
        throw new Error(`MCP server name "${name}" is not lower-case letters, digits, - and _`);
      if ((server.command === undefined) === (server.url === undefined))
        throw new Error(`MCP server "${name}" needs either command or url`);
      try {
        const fill = (record?: Record<string, string>) =>
          record === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(record).map(([key, value]) => [
                  key,
                  fillVariables(value, process.env),
                ]),
              );
        const env = fill(server.env);
        const headers = fill(server.headers);
        const sandboxed = server.command !== undefined && server.sandbox !== false;
        configs.set(name, {
          ...(server.command === undefined ? {} : { command: server.command }),
          ...(server.args === undefined ? {} : { args: server.args }),
          ...(env === undefined ? {} : { env }),
          ...(server.cwd === undefined || sandboxed ? {} : { cwd: server.cwd }),
          ...(sandboxed
            ? {
                sandbox: {
                  ...(dataDir === undefined ? {} : { home: join(dataDir, "servers", name) }),
                  ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
                  readable: settings.readable,
                },
              }
            : {}),
          ...(server.url === undefined ? {} : { url: server.url }),
          ...(headers === undefined ? {} : { headers }),
          timeoutMs: (server.timeoutSeconds ?? 60) * 1000,
        });
      } catch (error) {
        failed.push(`${name}: ${(error as Error).message}`);
      }
    }

    // Configured servers by name; the ones rooms added by `room/<room>/<id>`.
    const pool: McpPool = new McpPool(
      (key): ServerConfig | undefined => configs.get(key) ?? rooms.config(key),
      settings.idleMinutes * 60_000,
      VERSION,
    );
    const logins = new OAuthLogins(secrets, assistant, now);
    const rooms: RoomServers = new RoomServers(
      pool,
      secrets,
      logins,
      60_000,
      dataDir,
      settings.readable,
    );
    const panels = new Panels(documents, secrets, rooms, logins);
    // Tools are registered now, so each server is asked for its list once, at setup. One that
    // can't be reached is left out, and reported, rather than keeping the assistant from opening.
    const servers: Server[] = [];
    await Promise.all(
      [...configs].map(async ([name, config]) => {
        const settingsOf = settings.servers[name]!;
        try {
          const listed = await pool.listTools(name);
          const wanted = settingsOf.tools;
          servers.push({
            name,
            config,
            approval: settingsOf.approval ?? "writes",
            trustReadOnlyHint: settingsOf.trustReadOnlyHint === true,
            images: passesImages(settingsOf),
            tools: wanted === undefined ? listed : listed.filter((t) => wanted.includes(t.name)),
          });
        } catch (error) {
          failed.push(`${name}: ${(error as Error).message}`);
        }
      }),
    );
    servers.sort((a, b) => a.name.localeCompare(b.name));
    for (const problem of failed) console.error(`mcp: left out server ${problem}`);
    const warnings = [...imageWarnings(settings.servers), ...sandboxWarnings(settings.servers)];
    for (const warning of warnings) console.error(`mcp: ${warning}`);

    const call = async (server: Server, tool: string, args: Record<string, unknown>) =>
      forModel(await pool.callTool(server.name, tool, args), server.images);

    const tools: ToolRegistration[] = servers.flatMap((server) =>
      server.tools.map((tool): ToolRegistration => ({
        name: toolName(server.name, tool.name),
        description:
          `${tool.description ?? tool.title ?? tool.name} (from the MCP server ${server.name}` +
          (needsApproval(server, tool) ? "; someone in the conversation approves each call)" : ")"),
        // Providers require an object schema, and some reject one without `properties`.
        parameters: Type.Unsafe({
          ...tool.inputSchema,
          type: "object",
          properties: tool.inputSchema.properties ?? {},
        }),
        deferred: true,
        execute: async (args, api, context) => {
          const params = args as Record<string, unknown>;
          // Asked anyway, or asked only because of what the turn read.
          const after = needsApproval(server, tool) ? "" : readAfterUntrusted();
          if (!needsApproval(server, tool) && after === "") {
            try {
              return await call(server, tool.name, params);
            } catch (error) {
              return text((error as Error).message, true);
            }
          }
          const room = await roomOf(api, api.conversationId, context);
          const shown = JSON.stringify(params);
          try {
            const approval = await api.commit(
              (tx) =>
                requestApproval(
                  tx,
                  room.id,
                  {
                    extension: "mcp",
                    kind: "call",
                    summary:
                      `${server.name}: ${tool.title ?? tool.name} ` +
                      (shown.length > 300 ? `${shown.slice(0, 300)}…` : shown) +
                      after,
                    payload: { server: server.name, tool: tool.name, args: params as never },
                  },
                  now(),
                ),
              context,
            );
            return {
              ...text(`Waiting for approval ${approval.id}.`),
              details: { approval: approval.id },
            };
          } catch (error) {
            return text((error as Error).message, true);
          }
        },
      })),
    );

    const roomTools = roomServerTools({ rooms, panels, now });

    return {
      tools: [
        ...roomTools,
        // What a server answers is written elsewhere: data to the model (ADR 20).
        ...(tools.length === 0
          ? []
          : [...tools.map(returnsUntrusted), createToolSearchTool() as ToolRegistration]),
      ],
      roomSocket: panels.roomSocket,
      warnings: () => warnings,
      routes: [
        {
          method: "GET",
          path: "/oauth/callback",
          // The authorization server sends the person's browser here, without a token.
          auth: "none",
          handle: async (request) => {
            try {
              const { roomId, serverId } = await logins.finish(new URL(request.url).searchParams);
              rooms.changed(roomId, serverId);
              void panels.changed(roomId);
              return page("Signed in", "You can close this page and go back to Nudge.");
            } catch (error) {
              return page("Not signed in", (error as Error).message, 400);
            }
          },
        },
      ],
      sections: [
        // Said even with no tools, so the model can tell someone asking why it has none.
        section("mcp", async (input, context) => {
          const left =
            failed.length === 0
              ? ""
              : "\nMCP servers left out because they could not be set up or reached:\n" +
                failed.map((problem) => `- ${problem}`).join("\n");
          const configured =
            tools.length === 0
              ? configs.size + failed.length === 0
                ? ""
                : "No MCP tools from the extension's settings are available." + left
              : "Tools from MCP servers, named mcp__<server>__<tool>, are not loaded yet; find the " +
                "ones a task needs with tool_search. Servers:\n" +
                servers
                  .map(
                    (server) => `- ${server.name}: ${server.tools.map((t) => t.name).join(", ")}`,
                  )
                  .join("\n") +
                left;
          const room = await roomOf(input.read, input.conversationId, context);
          const added = await roomServersOf(input.read, room.id, context);
          const own =
            added.length === 0
              ? "No MCP servers were added in this conversation. When a task needs one, you can " +
                "add one with add_mcp_server, if you know its address or the program that runs it."
              : "MCP servers added in this conversation; see their tools with mcp_tools and call " +
                "them with mcp_call:\n" +
                added
                  .map((server) => {
                    const missing = rooms.missingKeys(room.id, server).map((key) => key.name);
                    const problem =
                      missing.length > 0
                        ? `needs ${missing.join(", ")} set on ${PANEL}`
                        : rooms.problem(room.id, server.id);
                    return (
                      `- ${server.name}: ${server.useFor}` +
                      (problem === undefined ? "" : ` (${problem})`)
                    );
                  })
                  .join("\n");
          return configured === "" ? own : `${configured}\n\n${own}`;
        }),
      ],
      approvals: {
        ...roomApprovals({ rooms, panels, now }),
        call: async (payload) => {
          const {
            server: name,
            tool,
            args,
          } = payload as {
            server: string;
            tool: string;
            args: Record<string, unknown>;
          };
          const server = servers.find((s) => s.name === name);
          if (server === undefined) return { text: `No MCP server "${name}" now`, isError: true };
          const result = await call(server, tool, args);
          return {
            text: result.output
              .map((part) => (part.type === "text" ? part.text : "[image]"))
              .join("\n"),
            ...(result.isError ? { isError: true } : {}),
            untrusted: toolName(name, tool),
          };
        },
      },
      close: () => pool.close(),
    };
  },
});

type Output = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** An MCP result as a tool result, images dropped unless allowed. */
function forModel(result: CallToolResult, images: boolean): { output: Output[]; isError?: true } {
  const output = toLlmContent(result).map((part): Output =>
    part.type === "text" || images ? part : { type: "text", text: "[an image, not shown]" },
  );
  return {
    output: output.length === 0 ? [{ type: "text", text: "(no output)" }] : output,
    ...(result.isError === true ? { isError: true as const } : {}),
  };
}

function text(value: string, isError = false) {
  return {
    output: [{ type: "text" as const, text: value }],
    ...(isError ? { isError } : {}),
  };
}

/** The servers people added to a room. */
async function roomServersOf(
  read: DocumentReader,
  roomId: string,
  context: Context,
): Promise<RoomServer[]> {
  const state = await read.snapshot(RoomServersDoc, roomId, context);
  return (state?.servers ?? []).map((server) => JSON.parse(JSON.stringify(server)) as RoomServer);
}

type RoomParts = {
  readonly rooms: RoomServers;
  readonly panels: Panels;
  readonly now: () => number;
};

const KEY = Type.Object({
  in: Type.Union([Type.Literal("header"), Type.Literal("env")], {
    description: "header for a remote server, env for a program",
  }),
  name: Type.String({ minLength: 1, description: "Such as Authorization or GITHUB_TOKEN." }),
  prefix: Type.Optional(Type.String({ description: 'Goes before the value, such as "Bearer ".' })),
});

/** At most this many tools in one `mcp_tools` answer. */
const LISTED = 40;

/** The tools for the servers a room adds: add, list and call them, and remove one. */
function roomServerTools({ rooms, panels, now }: RoomParts): ToolRegistration[] {
  const find = async (
    api: DocumentReader & { conversationId: number },
    name: string,
    context: Context,
  ) => {
    const room = await roomOf(api, api.conversationId, context);
    const server = (await roomServersOf(api, room.id, context)).find(
      (s) => s.name === name || s.id === name,
    );
    return { room, server };
  };

  const add = defineTool({
    name: "add_mcp_server",
    description:
      "Add an MCP server to this conversation, so you can use its tools: a remote one by its URL, " +
      "or a program the server starts (such as npx -y <package>). Waits for someone in the room " +
      "to approve it, and an admin for a program. Never put keys or tokens here: name them in " +
      "keys, and people set their values on the room's MCP panel. A remote server that signs in " +
      "with OAuth needs no keys; people sign in on the panel.",
    parameters: Type.Object({
      name: Type.String({ description: "Short, lower-case letters, digits, - and _." }),
      useFor: Type.String({ minLength: 1, description: "When to use it, in a sentence." }),
      url: Type.Optional(Type.String({ description: "A remote server's Streamable HTTP URL." })),
      command: Type.Optional(Type.String({ description: "The program to start, such as npx." })),
      args: Type.Optional(Type.Array(Type.String())),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), { description: "Non-secret headers." }),
      ),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Non-secret variables for the program.",
        }),
      ),
      keys: Type.Optional(Type.Array(KEY, { description: "Secrets people set on the panel." })),
    }),
    execute: async (args, api, context) => {
      const draft = args as ServerDraft;
      try {
        checkDraft(draft);
      } catch (error) {
        return text((error as Error).message, true);
      }
      const { room, server: taken } = await find(api, draft.name, context);
      if (taken !== undefined)
        return text(`This room has an MCP server "${draft.name}" already.`, true);
      const program = draft.command !== undefined;
      const summary = program
        ? `Start the program \`${describeServer(draft)}\` on the server as the MCP server ` +
          `"${draft.name}", for: ${draft.useFor}. It runs in a sandbox without Nudge's files, but ` +
          "with the network and whatever keys people give it, so only an admin can approve it."
        : `Add the MCP server "${draft.name}" at ${draft.url}, for: ${draft.useFor}`;
      try {
        const approval = await api.commit(
          (tx) =>
            requestApproval(
              tx,
              room.id,
              {
                extension: "mcp",
                kind: "add",
                summary,
                payload: draft as never,
                adminOnly: program,
              },
              now(),
            ),
          context,
        );
        return {
          ...text(`Waiting for approval ${approval.id}.`),
          details: { approval: approval.id },
        };
      } catch (error) {
        return text((error as Error).message, true);
      }
    },
  });

  const list = defineTool({
    name: "mcp_tools",
    description:
      "List the tools of an MCP server added in this conversation, with their inputs, to call " +
      "with mcp_call.",
    parameters: Type.Object({
      server: Type.String(),
      search: Type.Optional(Type.String({ description: "Words the tools must match." })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const { room, server } = await find(api, args.server, context);
      if (server === undefined) return text(`No MCP server "${args.server}" here.`, true);
      try {
        const listed = await rooms.tools(room.id, server);
        void panels.changed(room.id);
        const words = (args.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const matching = listed.filter((tool) => {
          const about = `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
          return words.every((word) => about.includes(word));
        });
        if (matching.length === 0)
          return text(listed.length === 0 ? `${server.name} has no tools.` : "No tools match.");
        const lines = matching.slice(0, LISTED).map((tool) => {
          const input = JSON.stringify(tool.inputSchema);
          return (
            `- ${tool.name}${needsApproval(server, tool) ? " (approved before it runs)" : ""}: ` +
            `${tool.description ?? tool.title ?? ""}\n  input: ` +
            (input.length > 800 ? `${input.slice(0, 800)}…` : input)
          );
        });
        const more =
          matching.length > LISTED
            ? `\n${matching.length - LISTED} more; search to narrow them.`
            : "";
        return text(lines.join("\n") + more);
      } catch (error) {
        void panels.changed(room.id);
        return text((error as Error).message, true);
      }
    },
  });

  const call = defineTool({
    name: "mcp_call",
    description:
      "Call a tool of an MCP server added in this conversation. Calls wait for someone in the " +
      "room to approve them, unless the room lets the server's read-only tools run at once.",
    parameters: Type.Object({
      server: Type.String(),
      tool: Type.String(),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    execute: async (args, api, context) => {
      const { room, server } = await find(api, args.server, context);
      if (server === undefined) return text(`No MCP server "${args.server}" here.`, true);
      const params = (args.arguments ?? {}) as Record<string, unknown>;
      try {
        const tool = (await rooms.tools(room.id, server)).find((t) => t.name === args.tool);
        if (tool === undefined)
          return text(`${server.name} has no tool "${args.tool}"; see mcp_tools.`, true);
        const after = needsApproval(server, tool) ? "" : readAfterUntrusted();
        if (!needsApproval(server, tool) && after === "")
          return forModel(await rooms.call(room.id, server, tool.name, params), ROOM_SERVER_IMAGES);
        const shown = JSON.stringify(params);
        const approval = await api.commit(
          (tx) =>
            requestApproval(
              tx,
              room.id,
              {
                extension: "mcp",
                kind: "roomCall",
                summary:
                  `${server.name}: ${tool.title ?? tool.name} ` +
                  (shown.length > 300 ? `${shown.slice(0, 300)}…` : shown) +
                  after,
                payload: { server: server.id, tool: tool.name, args: params as never },
              },
              now(),
            ),
          context,
        );
        return {
          ...text(`Waiting for approval ${approval.id}.`),
          details: { approval: approval.id },
        };
      } catch (error) {
        void panels.changed(room.id);
        return text((error as Error).message, true);
      }
    },
  });

  const remove = defineTool({
    name: "remove_mcp_server",
    description:
      "Remove an MCP server added in this conversation, with the keys and sign-in people gave it.",
    parameters: Type.Object({ server: Type.String() }),
    replay: "safe",
    execute: async (args, api, context) => {
      const room = await roomOf(api, api.conversationId, context);
      const removed = await api.commit((tx) => removeServer(tx, room.id, args.server), context);
      if (removed === undefined) return text(`No MCP server "${args.server}" here.`, true);
      rooms.removed(room.id, removed.id);
      void panels.changed(room.id);
      return text(`Removed the MCP server ${removed.name}.`);
    },
  });

  // What a server lists and answers is written elsewhere: data to the model (ADR 20).
  return [add, returnsUntrusted(list), returnsUntrusted(call), remove] as ToolRegistration[];
}

/** Runs what people approved for the servers rooms add. */
function roomApprovals({ rooms, panels, now }: RoomParts): ExtensionParts["approvals"] & {} {
  return {
    add: async (payload, run) => {
      const addedBy = run.approval.decidedBy?.displayName ?? "someone";
      const draft = payload as Partial<ServerDraft> | null;
      // Approvals asked for before the payload held the draft have none.
      if (typeof draft?.name !== "string")
        throw new Error("What to add was lost; ask for it again");
      const server = await run.commit((tx) =>
        addServer(tx, run.room.id, draft as ServerDraft, addedBy, now()),
      );
      let outcome: string;
      try {
        const tools = await rooms.tools(run.room.id, server);
        outcome =
          tools.length === 0
            ? " It has no tools."
            : ` Its tools: ${tools.map((tool) => tool.name).join(", ")}. See their inputs with mcp_tools.`;
      } catch (error) {
        outcome = ` It can't be used yet: ${(error as Error).message}.`;
      }
      void panels.changed(run.room.id);
      return { text: `Added the MCP server ${server.name}.${outcome}` };
    },
    roomCall: async (payload, run) => {
      const {
        server: id,
        tool,
        args,
      } = payload as {
        server: string;
        tool: string;
        args: Record<string, unknown>;
      };
      const server = await run.commit(async (tx) => {
        const stored = (await tx.doc(RoomServersDoc, run.room.id, null)).servers.find(
          (s) => s.id === id,
        );
        // Copied while the commit is open; its documents can't be read after.
        return stored === undefined
          ? undefined
          : (JSON.parse(JSON.stringify(stored)) as RoomServer);
      });
      if (server === undefined) return { text: `The MCP server ${id} was removed`, isError: true };
      const result = forModel(
        await rooms.call(run.room.id, server, tool, args),
        ROOM_SERVER_IMAGES,
      );
      return {
        text: result.output
          .map((part) => (part.type === "text" ? part.text : "[image]"))
          .join("\n"),
        ...(result.isError ? { isError: true } : {}),
        untrusted: "mcp_call",
      };
    },
  };
}

/**
 * Why a call that would run at once asks first, for its approval's summary: the turn read
 * untrusted data, and even a read-only tool's arguments could carry it out (ADR 20). Empty when
 * it read none.
 */
function readAfterUntrusted(): string {
  const { untrusted } = currentTurn();
  return untrusted === undefined
    ? ""
    : ` (after reading ${untrusted.join(", ")}: it could carry what the conversation holds)`;
}

/** The page the browser shows after a sign-in. */
function page(title: string, message: string, status = 200): Response {
  const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title></head>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
