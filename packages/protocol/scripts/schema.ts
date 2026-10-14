// Writes schema/v1.json from the TypeBox schemas: `pnpm -C packages/protocol schema`.
import { writeFile } from "node:fs/promises";
import { schemaDocument } from "../src/schema-document.ts";

await writeFile(new URL("../schema/v1.json", import.meta.url), schemaDocument());
