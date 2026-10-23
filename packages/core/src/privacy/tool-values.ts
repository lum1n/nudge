import type { Context } from "@earendil-works/chord";
import type { JsonObject, JsonValue, TSchema } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
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
      let given: unknown = args;
      if (!placeholders) {
        // Checked against the tool's own schema only now, with the values in: "⟦ORG1⟧" isn't
        // one of an enum's members, but the value behind it may be.
        const filled = mapStrings(args as JsonValue, (text) => rehydrate(viewer, text));
        try {
          given = validateToolArguments(tool, {
            type: "toolCall",
            id: "",
            name: tool.name,
            arguments: filled as JsonObject,
          });
        } catch (error) {
          const text = (error as Error).message;
          return redactResult({ output: [{ type: "text", text }], isError: true }, redact);
        }
      }
      const result = await inTurn({ ...turn, redact }, () =>
        tool.execute(given as typeof args, shown, context),
      );
      return redactResult(result, redact);
    },
    // The Harness checks arguments before they reach `execute`, with their placeholders.
    ...(placeholders ? {} : { parameters: allowingPlaceholders(tool.parameters) }),
  } as ToolRegistration;
}

/** Marks where `allowingPlaceholders` let a placeholder in; `withoutPlaceholders` takes it out. */
const ALLOWS_PLACEHOLDER = "x-nudge-placeholder";
/** A string holding a placeholder. */
const HOLDS_PLACEHOLDER = { type: "string", pattern: "⟦[A-Z]+\\d+⟧" };
/** Keywords a placeholder in place of the value can fail. */
const CONSTRAINTS = ["enum", "const", "pattern", "format", "minLength", "maxLength"];
const NOT_STRINGS = new Set(["number", "integer", "boolean"]);
/** Keywords holding schemas: by name, in a list, or as one. */
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions"];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_ONES = ["items", "additionalProperties"];

/**
 * A tool's schema that also takes a placeholder wherever one would fail it, such as an enum's
 * member, a number or an e-mail format, for the Harness's check before the values are put back.
 * The same schema when nothing in it would; what the model is offered is the schema without them.
 */
export function allowingPlaceholders(schema: TSchema): TSchema {
  const allowed = allowing(schema);
  return allowed === schema ? schema : (allowed as TSchema);
}

function allowing(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const node = schema as Record<string, unknown>;
  if (constrained(node)) return { anyOf: [node, HOLDS_PLACEHOLDER], [ALLOWS_PLACEHOLDER]: true };
  let changed: Record<string, unknown> | undefined;
  const set = (key: string, value: unknown) => {
    if (value === node[key]) return;
    changed ??= { ...node };
    changed[key] = value;
  };
  for (const key of SCHEMA_MAPS) {
    const map = node[key];
    if (typeof map !== "object" || map === null) continue;
    const entries = Object.entries(map).map(([name, sub]) => [name, allowing(sub)] as const);
    if (entries.some(([name, sub]) => sub !== (map as Record<string, unknown>)[name]))
      set(key, Object.fromEntries(entries));
  }
  for (const key of SCHEMA_LISTS) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    const mapped = list.map(allowing);
    if (mapped.some((sub, i) => sub !== list[i])) set(key, mapped);
  }
  for (const key of SCHEMA_ONES) set(key, allowing(node[key]));
  return changed ?? node;
}

/** A schema a placeholder would fail: constrained, or a union of only such. */
function constrained(node: Record<string, unknown>): boolean {
  if (CONSTRAINTS.some((keyword) => keyword in node)) return true;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.some((type) => NOT_STRINGS.has(type as string)) && !types.includes("string"))
    return true;
  const members = node.anyOf ?? node.oneOf;
  return (
    Array.isArray(members) &&
    members.length > 0 &&
    members.every((member) => typeof member === "object" && member !== null && constrained(member))
  );
}

/** A schema as the tool declared it: what `allowingPlaceholders` added taken out again. */
export function withoutPlaceholders<T>(schema: T): T {
  if (typeof schema !== "object" || schema === null) return schema;
  if (Array.isArray(schema)) {
    const mapped = schema.map(withoutPlaceholders);
    return (mapped.some((sub, i) => sub !== schema[i]) ? mapped : schema) as T;
  }
  const node = schema as Record<string, unknown>;
  if (node[ALLOWS_PLACEHOLDER] === true && Array.isArray(node.anyOf))
    return withoutPlaceholders(node.anyOf[0]) as T;
  let changed: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(node)) {
    const mapped = withoutPlaceholders(value);
    if (mapped === value) continue;
    changed ??= { ...node };
    changed[key] = mapped;
  }
  return (changed ?? schema) as T;
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
