import type { Context } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  Extension,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { mapStrings } from "./redact.ts";
import { inTurn, type Turn } from "./turn.ts";

const PLACEHOLDERS = Symbol("nudge.placeholders");

/**
 * Marks a tool that only stores what it is given, such as `remember`: it gets its arguments with
 * placeholders, as the model wrote them, so what it keeps holds no personal values. Every other
 * tool gets the values, since it acts on them.
 */
export function keepsPlaceholders<T extends ToolRegistration>(tool: T): T {
  return Object.assign(tool, { [PLACEHOLDERS]: true });
}

export type ToolValues = {
  /** The turn of a conversation, see `turnOf`. */
  readonly turn: (conversationId: ConversationId, context: Context) => Promise<Turn>;
  readonly redact: (text: string) => string;
  /** Puts back the values `viewer` may see; see `Vault.rehydrateFor`. */
  readonly rehydrate: (viewer: string | undefined, text: string) => string;
  /** Models that put values back, for tools that act on what a model answers. */
  readonly models: () => ToolExecutionApi["models"];
};

/**
 * The extension with every tool between the transcript's placeholders and the values: arguments
 * have their values put back (unless the tool `keepsPlaceholders`), and what the tool returns,
 * prints and reports goes back to placeholders before the Harness stores it. Each call runs in
 * its conversation's turn, so `currentTurn()` says whether it answers something private.
 */
export function withToolValues(extension: Extension, values: ToolValues): Extension {
  if (extension.tools === undefined || extension.tools.length === 0) return extension;
  return { ...extension, tools: extension.tools.map((tool) => wrap(tool, values)) };
}

function wrap(tool: ToolRegistration, values: ToolValues): ToolRegistration {
  const placeholders = (tool as { [PLACEHOLDERS]?: true })[PLACEHOLDERS] === true;
  const { redact, rehydrate } = values;
  const json = <T extends JsonValue | undefined>(value: T): T => mapStrings(value, redact);
  return {
    ...tool,
    execute: async (args, api, context) => {
      const turn = await values.turn(api.conversationId, context);
      const shown: ToolExecutionApi = {
        ...api,
        ...(placeholders ? {} : { models: values.models() }),
        // Replaced output can't take skips past this transform (see `outputWindow`).
        outputWindow: undefined,
        output: (chunk, skipped) =>
          api.output(typeof chunk === "string" ? redact(chunk) : chunk, skipped),
        details: (value, detailsContext) => api.details(json(value), detailsContext),
        diagnostic: (diagnostic) =>
          api.diagnostic({ ...diagnostic, message: redact(diagnostic.message) }),
      };
      // Only what the player the turn acts for may see: others' private values stay placeholders.
      const viewer = (turn.by ?? turn.privateTo)?.playerId;
      const given = placeholders
        ? args
        : mapStrings(args as JsonValue, (text) => rehydrate(viewer, text));
      const result = await inTurn({ ...turn, redact }, () =>
        tool.execute(given as typeof args, shown, context),
      );
      return redactResult(result, redact);
    },
  } as ToolRegistration;
}

function redactResult(
  result: ToolExecutionResult,
  redact: (text: string) => string,
): ToolExecutionResult {
  const json = <T extends JsonValue | undefined>(value: T): T => mapStrings(value, redact);
  return {
    ...result,
    ...(result.output === undefined
      ? {}
      : {
          output: result.output.map((block) =>
            block.type === "text" ? { ...block, text: redact(block.text) } : block,
          ),
        }),
    ...(result.structuredOutput === undefined
      ? {}
      : { structuredOutput: json(result.structuredOutput) }),
    ...(result.details === undefined ? {} : { details: json(result.details) }),
    ...(result.diagnostics === undefined
      ? {}
      : {
          diagnostics: result.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            message: redact(diagnostic.message),
          })),
        }),
  };
}
