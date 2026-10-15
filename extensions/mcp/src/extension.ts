import type { ToolRegistration } from "@earendil-works/pi-durable";
import { type CallToolResult, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import {
  defineNudgeExtension,
  type ExtensionParts,
  requestApproval,
  roomOf,
  section,
  Type,
} from "@nudge/core";
import { McpPool, type ServerConfig } from "./pool.ts";

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
    Type.String({ title: "Working directory", description: "The folder the program starts in." }),
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
   * the server marks read-only, `always` every one, `never` none.
   */
  approval: Type.Optional(
    Type.Union([Type.Literal("writes"), Type.Literal("always"), Type.Literal("never")], {
      description:
        "Which calls wait for someone in the room to approve: writes (all but read-only tools, the default), always or never.",
    }),
  ),
  /** Pass images in results to the model; default false, since redaction only reads text. */
  images: Type.Optional(
    Type.Boolean({
      description:
        "Pass images in the server's results to the model; off by default, since only text is redacted.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Seconds to wait for the server to answer a request; 60 when left out.",
    }),
  ),
});

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

type Server = {
  readonly name: string;
  readonly config: ServerConfig;
  readonly approval: "writes" | "always" | "never";
  readonly images: boolean;
  readonly tools: readonly Tool[];
};

/**
 * MCP servers' tools for the model. Each tool is `mcp__<server>__<tool>`, deferred, so the model
 * finds the ones it needs with `tool_search` instead of being offered them all. Calls that change
 * things wait for an approval. Results reach the model through the assistant's redaction like any
 * other tool output; images only where a server allows them.
 */
export default defineNudgeExtension({
  name: "mcp",
  version: VERSION,
  description:
    "Tools from MCP servers, found with tool_search; calls that change things are approved",
  settings: Type.Object({
    servers: Type.Record(Type.String(), ServerSettings, {
      default: {},
      description:
        "The MCP servers to use, by name in lowercase letters, digits, - and _; the name becomes part of each tool's name.",
    }),
    /** Close a server's connection, and stop a started program, after this long unused. */
    idleMinutes: Type.Number({
      default: 5,
      minimum: 0,
      description: "Minutes unused before a server's connection is closed and its program stopped.",
    }),
  }),
  setup: async ({ settings, now }): Promise<ExtensionParts> => {
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
        configs.set(name, {
          ...(server.command === undefined ? {} : { command: server.command }),
          ...(server.args === undefined ? {} : { args: server.args }),
          ...(env === undefined ? {} : { env }),
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
          ...(server.url === undefined ? {} : { url: server.url }),
          ...(headers === undefined ? {} : { headers }),
          timeoutMs: (server.timeoutSeconds ?? 60) * 1000,
        });
      } catch (error) {
        failed.push(`${name}: ${(error as Error).message}`);
      }
    }

    const pool = new McpPool(configs, settings.idleMinutes * 60_000, VERSION);
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
            images: settingsOf.images ?? false,
            tools: wanted === undefined ? listed : listed.filter((t) => wanted.includes(t.name)),
          });
        } catch (error) {
          failed.push(`${name}: ${(error as Error).message}`);
        }
      }),
    );
    servers.sort((a, b) => a.name.localeCompare(b.name));
    for (const problem of failed) console.error(`mcp: left out server ${problem}`);

    const needsApproval = (server: Server, tool: Tool) =>
      server.approval === "always" ||
      (server.approval === "writes" && tool.annotations?.readOnlyHint !== true);

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
          if (!needsApproval(server, tool)) {
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
                      (shown.length > 300 ? `${shown.slice(0, 300)}…` : shown),
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

    return {
      tools: tools.length === 0 ? [] : [...tools, createToolSearchTool() as ToolRegistration],
      sections: [
        section("mcp", () => {
          if (servers.length === 0) return undefined;
          return (
            "Tools from MCP servers, named mcp__<server>__<tool>, are not loaded yet; find the " +
            "ones a task needs with tool_search. Servers:\n" +
            servers
              .map((server) => `- ${server.name}: ${server.tools.map((t) => t.name).join(", ")}`)
              .join("\n")
          );
        }),
      ],
      approvals: {
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
