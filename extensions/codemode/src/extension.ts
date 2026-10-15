import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { CodemodeRun, CodemodeRunOptions } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { defineNudgeExtension, type ExtensionParts, Type } from "@nudge/core";

const VERSION = "0.1.0";

/**
 * The worker-thread QuickJS sandbox with a deadline on every run. Pi Durable starts runs with
 * `start()`, which has no deadline unless the script asks for one, so a `while (true) {}` would
 * spin a worker until someone stopped the answer.
 */
export class CappedSandbox extends CodemodeSandbox {
  constructor(
    private readonly maxTimeoutMs: number,
    memoryLimitBytes: number,
  ) {
    super({ timeoutMs: maxTimeoutMs, memoryLimitBytes });
  }

  override start(code: string, options: CodemodeRunOptions): CodemodeRun {
    const timeoutMs = Math.min(options.timeoutMs ?? Number.POSITIVE_INFINITY, this.maxTimeoutMs);
    return super.start(code, { ...options, timeoutMs });
  }
}

/**
 * Code mode: one `codemode` tool that runs a short JavaScript program calling the room's tools as
 * `tools.<name>(args)`, so the model can loop, filter and combine results in one step. Scripts run
 * in QuickJS inside a worker thread with no network, files, environment or timers; every tool call
 * goes through the room's normal tool execution, so approvals and redaction still apply, and only
 * the script's output reaches the transcript. Off unless the config installs it.
 */
export default defineNudgeExtension({
  name: "codemode",
  version: VERSION,
  description: "Run short scripts that call the room's tools, in a sandbox",
  settings: Type.Object({
    /** Longest a script may run, including the time its tool calls take. */
    timeoutSeconds: Type.Number({
      default: 30,
      minimum: 1,
      maximum: 600,
      description: "Seconds a script may run, including the time its tool calls take.",
    }),
    /** Memory the script's VM may allocate. */
    memoryMb: Type.Number({
      default: 64,
      minimum: 8,
      maximum: 1024,
      description: "Megabytes of memory a script may use.",
    }),
    /**
     * Give scripts `models.*` (classifiers and image generation, through the assistant's
     * redaction). Off by default, since each call is a paid model request.
     */
    models: Type.Boolean({
      default: false,
      description:
        "Let scripts call classifiers and image generation; each call is a paid model request.",
    }),
  }),
  setup: ({ settings }): ExtensionParts => {
    const sandbox = new CappedSandbox(settings.timeoutSeconds * 1000, settings.memoryMb * 2 ** 20);
    const { name: _, ...parts } = createCodemodeExtension({ sandbox, models: settings.models });
    return { ...parts, close: () => sandbox.close() };
  },
});
