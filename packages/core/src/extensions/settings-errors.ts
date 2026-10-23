import type { TSchema } from "typebox";
import { Value } from "typebox/value";

type Schema = {
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly anyOf?: readonly Schema[];
  readonly const?: unknown;
};

type SchemaError = {
  readonly keyword: string;
  readonly instancePath: string;
  readonly params: Record<string, unknown>;
  readonly message: string;
};

/** As the settings form labels a field: `apiBase` is "Api base". */
function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function child(schema: Schema | undefined, step: string): Schema | undefined {
  if (schema === undefined) return undefined;
  if (/^\d+$/.test(step) && schema.items !== undefined) return schema.items;
  return schema.properties?.[step];
}

/** The field at `path` as people see it in the form: `Hosts › 1 › Name`, with its schema. */
function locate(root: Schema, path: string): { label: string; schema: Schema | undefined } {
  const steps = path.split("/").slice(1);
  let schema: Schema | undefined = root;
  const labels: string[] = [];
  for (const step of steps) {
    const next = child(schema, step);
    labels.push(/^\d+$/.test(step) ? String(Number(step) + 1) : (next?.title ?? humanize(step)));
    schema = next;
  }
  return { label: labels.join(" › "), schema };
}

const TYPES: Record<string, string> = {
  string: "text",
  number: "a number",
  integer: "a whole number",
  boolean: "on or off",
  array: "a list",
  object: "a group of settings",
};

function sentence(error: SchemaError, schema: Schema | undefined, value: unknown): string {
  const { params } = error;
  const hint = schema?.description === undefined ? "" : ` ${schema.description}`;
  switch (error.keyword) {
    case "pattern":
    case "format":
      return `${JSON.stringify(value)} isn't valid here.${hint}`;
    case "type":
      return `must be ${TYPES[String(params.type)] ?? String(params.type)}.${hint}`;
    case "minLength":
      return params.limit === 1 ? "can't be empty." : `needs at least ${params.limit} characters.`;
    case "maxLength":
      return `can have at most ${params.limit} characters.`;
    case "minimum":
    case "exclusiveMinimum":
      return `must be ${error.keyword === "minimum" ? "at least" : "more than"} ${params.limit}.`;
    case "maximum":
    case "exclusiveMaximum":
      return `must be ${error.keyword === "maximum" ? "at most" : "less than"} ${params.limit}.`;
    case "minItems":
      return params.limit === 1 ? "needs at least one." : `needs at least ${params.limit}.`;
    case "anyOf": {
      const choices = (schema?.anyOf ?? []).map((option) => option.const);
      return choices.length > 0 && choices.every((choice) => typeof choice === "string")
        ? `must be one of ${choices.map((choice) => JSON.stringify(choice)).join(", ")}.`
        : `${JSON.stringify(value)} isn't valid here.${hint}`;
    }
    case "additionalProperties":
      return `has a setting it doesn't know: ${String(params.additionalProperty)}.`;
    default:
      return `${error.message}.`;
  }
}

function valueAt(value: unknown, path: string): unknown {
  let at = value;
  for (const step of path.split("/").slice(1))
    at = at === null || typeof at !== "object" ? undefined : (at as Record<string, unknown>)[step];
  return at;
}

/**
 * What is wrong with `value` against an extension's settings schema, a sentence per field in the
 * words its settings form uses, such as `Hosts › 1 › Port: must be a number.` rather than
 * `/hosts/0/port must be number`. At most `limit`.
 */
export function settingsProblems(schema: TSchema, value: unknown, limit = 5): string[] {
  const root = schema as Schema;
  const errors = [...Value.Errors(schema, value)] as SchemaError[];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    if (error.keyword === "required") {
      const missing = (error.params.requiredProperties as string[] | undefined) ?? [];
      for (const name of missing) {
        const { label } = locate(root, `${error.instancePath}/${name}`);
        if (seen.has(label)) continue;
        seen.add(label);
        out.push(`${label}: is missing.`);
      }
      continue;
    }
    // A union reports each option it tried, then itself; its own error says it best.
    if (
      error.keyword === "const" &&
      /\/anyOf\/\d+$/.test((error as { schemaPath?: string }).schemaPath ?? "")
    )
      continue;
    const { label, schema: field } = locate(root, error.instancePath);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(
      `${label || "Settings"}: ${sentence(error, field, valueAt(value, error.instancePath))}`,
    );
  }
  return out.slice(0, limit);
}
