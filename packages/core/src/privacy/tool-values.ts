import type { Context } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type Extension,
  type TaskId,
  type TaskRecord,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import { mapStrings } from "./redact.ts";
import { inTurn, type Owner, type SetsTurn, type Turn } from "./turn.ts";

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
  /** Models that put back the values `viewer` may see, for tools that act on what a model answers. */
  readonly models: (viewer: string | undefined) => ToolExecutionApi["models"];
};

/**
 * The extension with every tool between the transcript's placeholders and the values: arguments
 * have their values put back (unless the tool `keepsPlaceholders`), and what the tool returns,
 * prints and reports goes back to placeholders before the Harness stores it. Each call runs in
 * its conversation's turn, or the one a task above it sets (`SetsTurn`), so `currentTurn()` says
 * whether it answers something private.
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
      const turn =
        (await setTurnOf(api, context)) ?? (await values.turn(api.conversationId, context));
      // Only what the player the turn acts for may see: others' private values stay placeholders,
      // in the arguments and in what its models answer.
      const viewer = (turn.by ?? turn.privateTo)?.playerId;
      const shown: ToolExecutionApi = {
        ...api,
        ...(placeholders ? {} : { models: values.models(viewer) }),
        // Replaced output can't take skips past this transform (see `outputWindow`).
        outputWindow: undefined,
        output: (chunk, skipped) =>
          api.output(typeof chunk === "string" ? redact(chunk) : chunk, skipped),
        details: (value, detailsContext) => api.details(json(value), detailsContext),
        diagnostic: (diagnostic) =>
          api.diagnostic({ ...diagnostic, message: redact(diagnostic.message) }),
      };
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

/** How far up a tool call looks for a task that sets its turn; a script's tool call is two down. */
const SETS_TURN_DEPTH = 8;

/**
 * The turn the nearest task above this tool call sets (see `SetsTurn`): up through the tool tasks
 * of nested calls, to the first task that isn't one. Undefined when that task sets none, as for a
 * call the model makes, which answers what its conversation is in.
 */
async function setTurnOf(api: ToolExecutionApi, context: Context): Promise<Turn | undefined> {
  let id: TaskId | undefined = api.taskId;
  for (let depth = 0; id !== undefined && depth < SETS_TURN_DEPTH; depth++) {
    const record: TaskRecord<JsonValue, JsonValue, unknown> | undefined = await api.getTask(
      id,
      context,
    );
    if (record === undefined) return undefined;
    if (record.kind !== ToolTask.definition.name) {
      const set = (record.input as Partial<SetsTurn> | null)?.turn;
      if (typeof set !== "object" || set === null) return undefined;
      const owner = set.privateTo as Partial<Owner> | undefined;
      return typeof owner?.playerId === "string" && typeof owner.displayName === "string"
        ? { privateTo: { playerId: owner.playerId, displayName: owner.displayName } }
        : {};
    }
    id = record.owner;
  }
  return undefined;
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
