// A tiny MCP server on stdio for the tests: `lookup` (read-only), `save`, `env` (read-only, the
// variables it got), `pid` (read-only), `picture` (read-only, an image) and `read` (read-only, a
// file's text, or why it can't).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tools = [
  {
    name: "lookup",
    description: "Look up a word",
    inputSchema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "save",
    description: "Save a note",
    inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  },
  { name: "env", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "pid", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "picture", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  {
    name: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
];
const saved = [];

function answer(name, args) {
  switch (name) {
    case "lookup":
      return {
        content: [{ type: "text", text: `${args.word}: a word. Call Ann on +47 987 65 432.` }],
      };
    case "save":
      saved.push(args.note);
      return { content: [{ type: "text", text: `Saved ${saved.length} notes.` }] };
    case "env":
      return { content: [{ type: "text", text: JSON.stringify(process.env) }] };
    case "pid":
      return { content: [{ type: "text", text: String(process.pid) }] };
    case "picture":
      return { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] };
    case "read":
      try {
        return { content: [{ type: "text", text: readFileSync(args.path, "utf8") }] };
      } catch (error) {
        return { content: [{ type: "text", text: error.code }], isError: true };
      }
    default:
      return { content: [{ type: "text", text: `No tool ${name}` }], isError: true };
  }
}

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize")
    send({
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1" },
      },
    });
  else if (method === "tools/list") send({ id, result: { tools } });
  else if (method === "tools/call")
    send({ id, result: answer(params.name, params.arguments ?? {}) });
  else if (method === "ping") send({ id, result: {} });
  else send({ id, error: { code: -32601, message: `No method ${method}` } });
});
