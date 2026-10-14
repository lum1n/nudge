import {
  type CallToolResult,
  McpClient,
  type McpTransport,
  StdioTransport,
  StreamableHttpTransport,
  type Tool,
} from "@earendil-works/pi-mcp";

/** One MCP server as the settings give it, with `${VAR}`s already filled in. */
export type ServerConfig = {
  /** A program to start that speaks MCP on stdin and stdout. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** Variables for the program; it gets no others, apart from PATH, HOME and a few like them. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** A Streamable HTTP server, instead of a program. */
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
};

/** What a started program inherits from Nudge's environment; keys and tokens stay behind. */
const PASSED_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TZ"];

type Live = {
  readonly client: McpClient;
  busy: number;
  idle?: ReturnType<typeof setTimeout>;
};

/**
 * Connections to the configured servers: opened when a call needs one, shared by calls, closed
 * after `idleMs` without any. `close()` ends them all, those still in a call once it returns.
 */
export class McpPool {
  private readonly live = new Map<string, Promise<Live>>();
  private closed = false;

  constructor(
    private readonly servers: ReadonlyMap<string, ServerConfig>,
    private readonly idleMs: number,
    private readonly version: string,
  ) {}

  async listTools(server: string): Promise<Tool[]> {
    return this.use(server, (client, config) => client.listTools({ timeoutMs: config.timeoutMs }));
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return this.use(server, (client, config) =>
      client.callTool(tool, args, { timeoutMs: config.timeoutMs }),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    const all = await Promise.allSettled(this.live.values());
    for (const result of all)
      if (result.status === "fulfilled" && result.value.busy === 0) await this.end(result.value);
  }

  private async use<T>(
    server: string,
    run: (client: McpClient, config: ServerConfig) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error("The MCP extension was reloaded or closed; try again");
    const config = this.servers.get(server);
    if (config === undefined) throw new Error(`No MCP server "${server}"`);
    const pending = this.live.get(server) ?? this.open(server, config);
    const live = await pending;
    clearTimeout(live.idle);
    live.busy += 1;
    try {
      return await run(live.client, config);
    } finally {
      live.busy -= 1;
      if (live.busy === 0) {
        if (this.closed) await this.end(live);
        else live.idle = setTimeout(() => void this.end(live), this.idleMs);
      }
    }
  }

  private open(server: string, config: ServerConfig): Promise<Live> {
    const forget = () => {
      if (this.live.get(server) === pending) this.live.delete(server);
    };
    const pending = (async (): Promise<Live> => {
      const client = new McpClient({
        name: "nudge",
        version: this.version,
        requestTimeoutMs: config.timeoutMs,
      });
      // A server that exits or drops the connection is started again by the next call.
      client.onClose(forget);
      await client.connect(transport(config));
      return { client, busy: 0 };
    })();
    this.live.set(server, pending);
    pending.catch(forget);
    return pending;
  }

  private async end(live: Live): Promise<void> {
    clearTimeout(live.idle);
    await live.client.close().catch(() => {});
  }
}

function transport(config: ServerConfig): McpTransport {
  if (config.url !== undefined)
    return new StreamableHttpTransport({
      url: config.url,
      ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    });
  const env: Record<string, string> = {};
  for (const name of PASSED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return new StdioTransport({
    command: config.command!,
    ...(config.args === undefined ? {} : { args: config.args }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    env: { ...env, ...config.env },
    inheritEnv: false,
    stderr: "pipe",
  });
}
