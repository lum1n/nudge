import { PROTOCOL_VERSION, SCHEMAS } from "./schema.ts";

/** `schema/v1.json`'s text: every named schema under `$defs`. */
export function schemaDocument(): string {
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://nudge.dev/protocol/v${PROTOCOL_VERSION}.json`,
    title: `Nudge protocol v${PROTOCOL_VERSION}`,
    $defs: SCHEMAS,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
