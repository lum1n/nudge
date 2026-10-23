import type { JsonObject, ToolRegistration } from "@earendil-works/pi-durable";

const READS = Symbol("nudge.reads");

type Reads = true | ((args: JsonObject) => boolean);

/**
 * Marks a tool that only looks things up and changes nothing, such as `web_search`: a saved script
 * may call it when nobody is watching. `when` narrows it to some calls, such as `call_api` with GET.
 * Every tool without the mark is kept from scripts.
 */
export function readsOnly<T extends ToolRegistration>(
  tool: T,
  when?: (args: JsonObject) => boolean,
): T {
  return Object.assign(tool, { [READS]: when ?? true });
}

/** Whether a tool is marked `readsOnly`, for some calls at least. */
export function canRead(tool: ToolRegistration): boolean {
  return (tool as { [READS]?: Reads })[READS] !== undefined;
}

/** Whether this call of a tool only reads. */
export function onlyReads(tool: ToolRegistration, args: JsonObject): boolean {
  const reads = (tool as { [READS]?: Reads })[READS];
  return reads === true || (reads !== undefined && reads(args));
}
