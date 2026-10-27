import type {
  AccBackend,
  AccCommand,
  AccEvent,
  AccHost,
  AccItem,
  AccSession,
  DetachedStatus,
  HarnessId,
  SessionConfig,
  SshConfig,
} from "../src/index.ts";

/** A session's log on the fake host: batches of events, read by every attachment from the start. */
export type Log = {
  readonly harness: HarnessId;
  readonly cwd: string;
  readonly batches: AccEvent[][];
  readonly waiters: (() => void)[];
  items: AccItem[];
  readonly sent: AccCommand[];
};

export function push(log: Log, ...events: AccEvent[]): void {
  log.batches.push(events);
  for (const wake of log.waiters.splice(0)) wake();
}

export class FakeSession implements AccSession {
  offset = 0;
  constructor(
    readonly id: string,
    private readonly log: Log,
  ) {}
  async nextEvents(): Promise<AccEvent[]> {
    while (this.offset >= this.log.batches.length)
      await new Promise<void>((resolve) => this.log.waiters.push(resolve));
    return this.log.batches[this.offset++]!;
  }
  async send(command: AccCommand): Promise<void> {
    this.log.sent.push(command);
  }
  async stop(): Promise<void> {
    push(this.log, { type: "exited", code: 0 });
  }
  async status(): Promise<DetachedStatus> {
    return { status: "alive", pid: 1, size: this.log.batches.length };
  }
  state() {
    return null;
  }
  topLevelItems(): AccItem[] {
    return this.log.items;
  }
}

/** ACC's binding as the extension uses it, with one host whose key the test can change. */
export class FakeAcc implements AccBackend {
  fingerprint = "SHA256:one";
  readonly logs = new Map<string, Log>();
  readonly configs: (SshConfig | "local")[] = [];
  keys = 0;
  /** Scripts run on hosts, with what was on their standard input. */
  readonly execs: { host: string; script: string; stdin: string }[] = [];
  /** Answers a script instead of the default; undefined for the default. */
  onExec:
    | ((script: string) => { stdout?: string; stderr?: string; exitCode?: number } | undefined)
    | undefined;
  private ids = 0;

  /** Configs of the hosts made, `"local"` for this machine. */
  localHost = (): AccHost => {
    this.configs.push("local");
    return this.make({
      host: "localhost",
      user: "",
      auth: { agent: true },
      hostKey: { acceptAny: true },
    });
  };

  host(config: SshConfig): AccHost {
    this.configs.push(config);
    return this.make(config);
  }

  private make(config: SshConfig): AccHost {
    return {
      connect: async () => {
        if (
          "fingerprints" in config.hostKey &&
          !config.hostKey.fingerprints.includes(this.fingerprint)
        )
          throw Object.assign(new Error(`untrusted host key ${this.fingerprint}`), {
            code: "HostKeyRejected",
          });
      },
      disconnect: async () => {},
      hostKeyFingerprint: () => this.fingerprint,
      exec: async (script: string, stdin?: Buffer | null) => {
        this.execs.push({ host: config.host, script, stdin: stdin?.toString("utf8") ?? "" });
        const answered = this.onExec?.(script);
        if (answered !== undefined)
          return {
            stdout: Buffer.from(answered.stdout ?? ""),
            stderr: Buffer.from(answered.stderr ?? ""),
            exitCode: answered.exitCode ?? 0,
          };
        return script.includes("missing")
          ? { stdout: Buffer.alloc(0), stderr: Buffer.from("no such directory"), exitCode: 1 }
          : { stdout: Buffer.from("/home/u/proj\n"), stderr: Buffer.alloc(0), exitCode: 0 };
      },
      probe: async () => {
        return [
          {
            harness: "claude" as const,
            path: "/usr/bin/claude",
            version: "2.1.0",
            compat: "tested" as const,
          },
        ];
      },
      listSessions: async () => {
        return [...this.logs].map(([id, log]) => ({
          id,
          status: { status: "alive" as const, pid: 1, size: log.batches.length },
          modified: 0,
          spec: { harness: log.harness, cwd: log.cwd, model: null, title: null, created_ms: 0 },
        }));
      },
      launchSession: async (id: string, session: SessionConfig) => {
        const log: Log = {
          harness: session.harness,
          cwd: session.cwd,
          batches: [],
          waiters: [],
          items: [],
          sent: [],
        };
        this.logs.set(id, log);
        return new FakeSession(id, log);
      },
      attachSession: (id: string) => {
        const log = this.logs.get(id);
        if (log === undefined) throw new Error(`no session ${id}`);
        return new FakeSession(id, log);
      },
      removeSession: async (id: string) => {
        this.logs.delete(id);
      },
    };
  }

  generateKey(comment: string) {
    this.keys++;
    return { privateKey: "PRIVATE KEY", publicKey: `ssh-ed25519 AAAA ${comment}` };
  }

  newSessionId(harness: HarnessId): string {
    return `${harness}-s${++this.ids}`;
  }
}
