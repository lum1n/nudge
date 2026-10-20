import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The harnesses ACC drives. */
export type HarnessId = "claude" | "codex" | "cursor" | "copilot" | "pi" | "opencode";

export type PermissionOption = {
  readonly id: string;
  readonly label: string;
  readonly kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

export type RunState =
  | { readonly state: "idle" | "done" | "error" | "exited" | "waiting" }
  | { readonly state: "working"; readonly progress: number | null }
  | { readonly state: "blocked"; readonly kind: "permission" | "question" | "auth" };

export type SessionState = {
  readonly state: RunState;
  readonly message: string | null;
  readonly source: string;
  readonly observed_at_ms: number;
};

/** The events of acc-core this extension acts on; the others pass by. */
export type AccEvent =
  | {
      readonly type: "permission_requested";
      readonly request_id: string;
      readonly title: string;
      readonly options: readonly PermissionOption[];
      readonly kind?: "permission" | "question" | "auth";
      readonly input?: unknown;
    }
  | { readonly type: "permission_resolved"; readonly request_id: string }
  | ({ readonly type: "state_changed" } & SessionState)
  | { readonly type: "turn_completed" }
  | { readonly type: "exited"; readonly code: number | null }
  | { readonly type: "session_started"; readonly native_id: string; readonly model: string | null }
  | { readonly type: string };

export type AccCommand =
  | { readonly type: "prompt"; readonly text: string }
  | { readonly type: "interrupt" }
  | { readonly type: "compact"; readonly hint: string | null }
  | {
      readonly type: "set_option";
      readonly id: "model" | "effort" | "mode" | "permission";
      readonly value: string;
    }
  | { readonly type: "answer_permission"; readonly request_id: string; readonly option_id: string };

export type AccItem = {
  readonly id: string;
  readonly kind:
    | "user_message"
    | "agent_message"
    | "reasoning"
    | "tool_call"
    | "command_execution"
    | "file_change"
    | "subagent";
  readonly status: "running" | "completed" | "failed";
  readonly text: string;
  readonly detail: {
    readonly type: string;
    readonly title?: string;
    readonly command?: string;
    readonly files?: readonly { readonly path: string }[];
  };
};

export type DetachedStatus =
  | { readonly status: "alive"; readonly pid: number; readonly size: number }
  | { readonly status: "exited"; readonly code: number | null; readonly size: number }
  | { readonly status: "missing" };

export type DetachedInfo = {
  readonly id: string;
  readonly status: DetachedStatus;
  /** Seconds since the Unix epoch. */
  readonly modified: number | null;
  readonly spec: {
    readonly harness: HarnessId;
    readonly cwd: string;
    readonly model: string | null;
    readonly title: string | null;
    readonly created_ms: number;
  } | null;
};

export type Availability = {
  readonly harness: HarnessId;
  readonly path: string;
  readonly version: string | null;
  readonly compat: "tested" | "newer" | "older" | "unknown";
};

export type SessionConfig = {
  readonly harness: HarnessId;
  readonly cwd: string;
  readonly model?: string | null;
};

export type SshConfig = {
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  readonly auth:
    | { readonly privateKey: string }
    | { readonly password: string }
    | { readonly agent: true; readonly agentSocket?: string };
  readonly hostKey: { readonly fingerprints: string[] } | { readonly acceptAny: true };
  readonly connectTimeoutMs?: number;
};

/** A detached harness session on a host (`RemoteSession` in `@acc/node`). */
export interface AccSession {
  readonly id: string;
  /** Log bytes read so far. */
  readonly offset: number;
  nextEvents(): Promise<AccEvent[]>;
  send(command: AccCommand): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<DetachedStatus>;
  state(): SessionState | null;
  topLevelItems(): AccItem[];
}

/** A host over SSH (`SshHost` in `@acc/node`). */
export interface AccHost {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  hostKeyFingerprint(): string | null;
  exec(
    script: string,
    stdin?: Buffer | null,
  ): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }>;
  probe(): Promise<Availability[]>;
  listSessions(): Promise<DetachedInfo[]>;
  launchSession(id: string, config: SessionConfig): Promise<AccSession>;
  attachSession(id: string, config: SessionConfig): AccSession;
  removeSession(id: string): Promise<void>;
}

/** What the extension needs of `@acc/node`; tests pass a fake. */
export interface AccBackend {
  host(config: SshConfig): AccHost;
  generateKey(comment: string): { privateKey: string; publicKey: string };
  newSessionId(harness: HarnessId): string;
}

type AccModule = {
  SshHost: new (config: SshConfig) => AccHost;
  generateKey(comment: string): { privateKey: string; publicKey: string };
  newSessionId(harness: HarnessId, entropy: Buffer): string;
};

/**
 * Loads ACC's Node binding (github.com/lum1n/acc): from `NUDGE_ACC_MODULE` (a path to its
 * index.js) when set, else the copy a release ships in `acc-node/`, else a checkout's `.acc-node/`
 * (`pnpm acc:fetch`). Undefined when none loads on this machine.
 */
export function loadAcc(): AccBackend | undefined {
  const from = process.env.NUDGE_ACC_MODULE;
  // A release has Node in node/bin and ACC in acc-node/; a checkout has it in .acc-node/ (from
  // extensions/acc/src or extensions/acc/dist).
  const bundled = join(dirname(process.execPath), "..", "..", "acc-node", "index.js");
  const checkout = join(import.meta.dirname, "..", "..", "..", ".acc-node", "index.js");
  const candidates = from ? [from] : [bundled, checkout].filter((path) => existsSync(path));
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    try {
      const acc = require(candidate) as AccModule;
      if (typeof acc.SshHost !== "function") continue;
      return {
        host: (config) => new acc.SshHost(config),
        generateKey: (comment) => acc.generateKey(comment),
        newSessionId: (harness) =>
          acc.newSessionId(harness, Buffer.from(crypto.getRandomValues(new Uint8Array(15)))),
      };
    } catch {
      // Not there, or not loadable on this platform: try the next.
    }
  }
  return undefined;
}

/** The kind of a thrown ACC error (`HostKeyRejected`, `NotRunning`…), or undefined. */
export function accErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
