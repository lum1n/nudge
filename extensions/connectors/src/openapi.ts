import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConnectorError } from "./net.ts";

type JsonRecord = Record<string, unknown>;

export type OpenApiSpec = {
  readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components?: { readonly schemas?: Readonly<Record<string, unknown>> };
  readonly [key: string]: unknown;
};

const METHODS = ["get", "post", "put", "patch", "delete", "head"];
const MAX_RESULTS = 20;
/** How many `$ref` hops are followed in a chain, to bound a cycle — not how deep the object tree goes. */
const MAX_REF_CHAIN = 5;

/**
 * Fetches an OpenAPI spec (JSON only — YAML specs need a separate `docsUrl` pointing at the JSON
 * variant most tooling also publishes) and caches it in `cacheDir`, if given. Falls back to the
 * cache when the fetch fails and one exists.
 */
export async function fetchSpec(docsUrl: string, cacheDir?: string): Promise<OpenApiSpec> {
  const cacheFile = cacheDir === undefined ? undefined : join(cacheDir, cacheName(docsUrl));
  try {
    const response = await fetch(docsUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new ConnectorError(`${docsUrl}: HTTP ${response.status}`);
    const text = await response.text();
    const spec = parse(text, docsUrl);
    if (cacheFile !== undefined) await writeFile(cacheFile, text, "utf8").catch(() => {});
    return spec;
  } catch (error) {
    if (cacheFile !== undefined) {
      const cached = await readFile(cacheFile, "utf8").catch(() => undefined);
      if (cached !== undefined) return parse(cached, docsUrl);
    }
    throw error instanceof ConnectorError
      ? error
      : new ConnectorError(`Could not fetch ${docsUrl}: ${(error as Error).message}`);
  }
}

function parse(text: string, docsUrl: string): OpenApiSpec {
  try {
    return JSON.parse(text) as OpenApiSpec;
  } catch {
    throw new ConnectorError(`${docsUrl} is not JSON; only JSON OpenAPI specs are read, not YAML`);
  }
}

function cacheName(docsUrl: string): string {
  return `openapi-${Buffer.from(docsUrl).toString("base64url").slice(0, 40)}.json`;
}

/**
 * Operations whose method, path, summary or operationId mention every word of `query`
 * (case-insensitive), or every operation when `query` is empty — capped so the model doesn't drown
 * in output. One compact line each: `GET /locations/{id} — Find a location — id, name`.
 */
export function searchOperations(spec: OpenApiSpec, query = ""): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const operation = (methods as JsonRecord)[method] as JsonRecord | undefined;
      if (operation === undefined) continue;
      const summary = typeof operation.summary === "string" ? operation.summary : "";
      const operationId = typeof operation.operationId === "string" ? operation.operationId : "";
      const haystack = `${method} ${path} ${summary} ${operationId}`.toLowerCase();
      if (words.length > 0 && !words.every((word) => haystack.includes(word))) continue;
      const params = paramNames(operation);
      lines.push(
        `${method.toUpperCase()} ${path}` +
          (summary ? ` — ${summary}` : "") +
          (params.length > 0 ? ` — ${params.join(", ")}` : ""),
      );
      if (lines.length >= MAX_RESULTS) return lines;
    }
  }
  return lines;
}

/** One operation's parameters and request body, `$ref`s resolved a few levels deep. */
export function describeOperation(
  spec: OpenApiSpec,
  method: string,
  path: string,
): string | undefined {
  const operation = (spec.paths?.[path] as JsonRecord | undefined)?.[method.toLowerCase()] as
    | JsonRecord
    | undefined;
  if (operation === undefined) return undefined;
  const resolved = resolveRefs(operation, spec, MAX_REF_CHAIN);
  const lines = [`${method.toUpperCase()} ${path}`];
  if (typeof operation.summary === "string") lines.push(operation.summary);
  const params = (resolved as { parameters?: JsonRecord[] }).parameters ?? [];
  for (const param of params)
    lines.push(
      `- ${param.in ?? "param"} ${param.name}${param.required ? " (required)" : ""}: ${describeSchema(param.schema as JsonRecord | undefined)}`,
    );
  const body = (resolved as { requestBody?: JsonRecord }).requestBody;
  const bodySchema = (
    (body?.content as JsonRecord | undefined)?.["application/json"] as JsonRecord | undefined
  )?.schema as JsonRecord | undefined;
  if (bodySchema !== undefined) lines.push(`- body: ${describeSchema(bodySchema)}`);
  return lines.join("\n");
}

function paramNames(operation: JsonRecord): string[] {
  const params = (operation.parameters as JsonRecord[] | undefined) ?? [];
  return params.map((p) => String(p.name ?? "")).filter(Boolean);
}

function describeSchema(schema: JsonRecord | undefined): string {
  if (schema === undefined) return "any";
  if (typeof schema.type === "string") {
    if (schema.type === "object" && schema.properties)
      return `object { ${Object.keys(schema.properties as JsonRecord).join(", ")} }`;
    if (schema.type === "array") return `array of ${describeSchema(schema.items as JsonRecord)}`;
    return schema.type;
  }
  return "any";
}

/**
 * Replaces `$ref` pointers within the same document. `depth` bounds how many `$ref`s are followed
 * in a chain (a cycle guard), not how deep the object tree is walked — plain nesting is unbounded.
 */
function resolveRefs(value: unknown, spec: OpenApiSpec, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, spec, depth));
  const record = value as JsonRecord;
  if (typeof record.$ref === "string") {
    if (depth <= 0) return value;
    const target = lookupRef(spec, record.$ref);
    return target === undefined ? value : resolveRefs(target, spec, depth - 1);
  }
  const out: JsonRecord = {};
  for (const [key, inner] of Object.entries(record)) out[key] = resolveRefs(inner, spec, depth);
  return out;
}

function lookupRef(spec: OpenApiSpec, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = spec;
  for (const part of ref.slice(2).split("/")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as JsonRecord)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
}
