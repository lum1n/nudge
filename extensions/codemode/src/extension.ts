import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { CodemodeRun, CodemodeRunOptions } from "@earendil-works/pi-codemode";
import type {
  NestedToolExecutionResult,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
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

/** The approval a tool's result waits for: tools that ask for one put its id in `details.approval`. */
function approvalOf(result: NestedToolExecutionResult): string | undefined {
  const details = result.details;
  if (result.isError || typeof details !== "object" || details === null || Array.isArray(details))
    return undefined;
  const id = details["approval"];
  return typeof id === "string" ? id : undefined;
}

/** What a script gets instead of the result of a call that waits for approval. */
export function waitingValue(id: string, name: string): string {
  return (
    `Waiting for approval ${id}: tools.${name} has not run yet, and its result will not come ` +
    "back to this script. It arrives later as a new message, once someone decides."
  );
}

/** What the model is told after a script whose calls wait for approval. */
export function waitingNote(waiting: ReadonlyMap<string, string>): string {
  const list = [...waiting].map(([id, name]) => `${id} (tools.${name})`).join(", ");
  return (
    `Waiting for approval: ${list}. Those calls have not run; the script got a placeholder ` +
    "instead of their results. Each outcome arrives as a new message once someone decides; " +
    "don't make the calls again."
  );
}

/**
 * The code mode tool, made clear about calls that wait for approval. Such a call returns at once
 * (ADR 6), so a script would otherwise get "Waiting for approval a1." as if it were the result:
 * a schema-less tool's value becomes a placeholder that says so, and the model is told which calls
 * wait. The call still asks for the approval as usual; nothing runs before someone approves it.
 * Why the script isn't resumed with the outcome, and how it could be: ADR 18.
 */
export function waitingAware(tool: ToolRegistration): ToolRegistration {
  return {
    ...tool,
    execute: async (args, api, context) => {
      const waiting = new Map<string, string>();
      const executeTool: ToolExecutionApi["executeTool"] = async (name, callArgs, ctx, options) => {
        const result = await api.executeTool(name, callArgs, ctx, options);
        const id = approvalOf(result);
        if (id === undefined) return result;
        waiting.set(id, name);
        // A tool with a schema returned a value of its own for the wait; it is kept.
        return typeof result.structuredOutput === "string"
          ? { ...result, structuredOutput: waitingValue(id, name) }
          : result;
      };
      const result = await tool.execute(args, { ...api, executeTool }, context);
      if (waiting.size === 0) return result;
      return {
        ...result,
        output: [...(result.output ?? []), { type: "text", text: `\n\n${waitingNote(waiting)}` }],
      };
    },
  };
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
    const {
      name: _,
      tools = [],
      ...parts
    } = createCodemodeExtension({
      sandbox,
      models: settings.models,
    });
    return {
      ...parts,
      tools: tools.map((tool) => (tool.name === CODEMODE_TOOL_NAME ? waitingAware(tool) : tool)),
      close: () => sandbox.close(),
    };
  },
});
