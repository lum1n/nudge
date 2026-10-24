import {
  currentTurn,
  defineNudgeExtension,
  defineTool,
  type ExtensionParts,
  readsOnly,
  requestApproval,
  returnsUntrusted,
  roomOf,
  scrubSecrets,
  section,
  Type,
} from "@nudge/core";
import { describeOperation, fetchSpec, searchOperations } from "./openapi.ts";
import {
  addConnector,
  type Connector,
  removeConnector,
  updateConnector,
  visibleConnectors,
} from "./model.ts";
import { ConnectorError, fetchLocked, lockedUrl } from "./net.ts";
import { Panels } from "./panel.ts";

const READ_METHODS = new Set(["GET", "HEAD"]);
const AUTH_SCHEMA = Type.Object({
  in: Type.Union([Type.Literal("header"), Type.Literal("query")]),
  name: Type.String({ minLength: 1 }),
  prefix: Type.Optional(Type.String()),
});

/**
 * Lets the model use APIs the people in a room add and teach it about. Reads (GET, HEAD, or a
 * path a person marked as safe) run at once; anything else waits for someone in the room to
 * approve it. Nothing is built in: connectors come only from what a room adds.
 */
export default defineNudgeExtension({
  name: "connectors",
  version: "0.1.0",
  apiVersion: "1.0",
  description: "Call APIs the room adds and teaches it about",
  setup: ({ secrets, dataDir, now, documents }): ExtensionParts => {
    // Each room's connectors panel: keys, the private network, read paths, sharing.
    const panels = new Panels(documents, secrets);
    const specCache = dataDir === undefined ? undefined : `${dataDir}/openapi-cache`;

    const text = (value: string, isError = false) => ({
      output: [{ type: "text" as const, text: value }],
      ...(isError ? { isError } : {}),
    });

    const addTool = defineTool({
      name: "add_connector",
      description:
        "Add an API the room can call, for example a weather or transport service. Waits for " +
        "someone in the room to approve it. Say what it's for; people set any API key afterwards " +
        "in the web app, never here.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1 }),
        baseUrl: Type.String({ description: "Everything calls stay under this address." }),
        useFor: Type.String({ minLength: 1, description: "When to use it, in a sentence." }),
        alwaysFirst: Type.Optional(
          Type.Boolean({
            description:
              "True when the user wants it tried first, before anything else, for those tasks.",
          }),
        ),
        docsUrl: Type.Optional(
          Type.String({ description: "A JSON OpenAPI spec, if the API has one." }),
        ),
        headers: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description: "Static, non-secret headers sent on every call.",
          }),
        ),
        auth: Type.Optional(AUTH_SCHEMA),
      }),
      execute: async (args, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        try {
          const approval = await api.commit(
            (tx) =>
              requestApproval(
                tx,
                room.id,
                {
                  extension: "connectors",
                  kind: "add",
                  summary:
                    `Add the connector "${args.name}" (${args.baseUrl}) for: ${args.useFor}` +
                    (args.alwaysFirst === true ? " (always first)" : ""),
                  payload: { ...args },
                },
                now(),
              ),
            context,
          );
          return {
            ...text(`Waiting for approval ${approval.id}.`),
            details: { approval: approval.id },
          };
        } catch (error) {
          return text((error as Error).message, true);
        }
      },
    });

    const updateTool = defineTool({
      name: "update_connector",
      description:
        "Change what you've learned about a connector (what it's for, how to use it, where its " +
        "docs are) or its non-secret headers. Changing its base address, whether it comes " +
        "first, or what one that comes first is for waits for approval.",
      parameters: Type.Object({
        connector: Type.String({ description: "From the connectors section, like c1." }),
        useFor: Type.Optional(Type.String({ minLength: 1 })),
        alwaysFirst: Type.Optional(
          Type.Boolean({
            description:
              "Whether the user wants it tried first, before anything else, for those tasks.",
          }),
        ),
        notes: Type.Optional(
          Type.String({ description: "What you've learned about using this API." }),
        ),
        docsUrl: Type.Optional(Type.String()),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        baseUrl: Type.Optional(Type.String()),
      }),
      execute: async ({ connector: id, baseUrl, useFor, alwaysFirst, ...rest }, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        if (baseUrl !== undefined) {
          try {
            const approval = await api.commit(
              (tx) =>
                requestApproval(
                  tx,
                  room.id,
                  {
                    extension: "connectors",
                    kind: "updateBaseUrl",
                    summary: `Change connector "${id}"'s address to ${baseUrl}`,
                    payload: { connector: id, baseUrl },
                  },
                  now(),
                ),
              context,
            );
            return {
              ...text(`Waiting for approval ${approval.id}.`),
              details: { approval: approval.id },
            };
          } catch (error) {
            return text((error as Error).message, true);
          }
        }
        const current = (await visibleConnectors(api, room.id, context)).find((c) => c.id === id);
        // Which connector comes first, and for what, is the people's rule: the model only asks.
        const rule: { useFor?: string; alwaysFirst?: boolean } = {
          ...(alwaysFirst !== undefined && alwaysFirst !== (current?.alwaysFirst === true)
            ? { alwaysFirst }
            : {}),
          ...(useFor !== undefined && (alwaysFirst === true || current?.alwaysFirst === true)
            ? { useFor }
            : {}),
        };
        const patch = { ...rest, ...(useFor === undefined || "useFor" in rule ? {} : { useFor }) };
        const done: string[] = [];
        try {
          if (Object.keys(patch).length > 0 || Object.keys(rule).length === 0) {
            const updated = await api.commit(
              (tx) => updateConnector(tx, room.id, id, patch),
              context,
            );
            void panels.changed(room.id);
            done.push(`Updated connector ${updated.id}.`);
          }
          if (Object.keys(rule).length > 0) {
            if (current === undefined) return text(`No connector "${id}" in this room`, true);
            const approval = await api.commit(
              (tx) =>
                requestApproval(
                  tx,
                  room.id,
                  {
                    extension: "connectors",
                    kind: "rule",
                    summary: ruleSummary(current, rule),
                    payload: { connector: id, ...rule },
                  },
                  now(),
                ),
              context,
            );
            done.push(`Waiting for approval ${approval.id}.`);
            return { ...text(done.join(" ")), details: { approval: approval.id } };
          }
          return text(done.join(" "));
        } catch (error) {
          return text([...done, (error as Error).message].join(" "), done.length === 0);
        }
      },
    });

    const removeTool = defineTool({
      name: "remove_connector",
      description: "Remove a connector this room added. Reversible by adding it again.",
      parameters: Type.Object({ connector: Type.String() }),
      replay: "safe",
      execute: async ({ connector: id }, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        const removed = await api.commit((tx) => removeConnector(tx, room.id, id), context);
        secrets.delete(room.id, id);
        void panels.changed(room.id);
        return removed
          ? text(`Removed connector ${id}.`)
          : text(`No connector "${id}" added in this room.`, true);
      },
    });

    const callTool = defineTool({
      name: "call_api",
      description:
        "Call one of this room's connectors. Reads run at once. Anything that changes something " +
        "waits for someone in the room to approve it first.",
      parameters: Type.Object({
        connector: Type.String({ description: "From the connectors section, like c1." }),
        method: Type.Union(
          ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map((m) => Type.Literal(m)),
        ),
        path: Type.String({ description: "Joined onto the connector's base address." }),
        query: Type.Optional(Type.Record(Type.String(), Type.String())),
        body: Type.Optional(Type.String({ description: "Sent as the request body, if any." })),
      }),
      execute: async (args, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        const connectors = await visibleConnectors(api, room.id, context);
        const connector = connectors.find((c) => c.id === args.connector);
        if (connector === undefined) return text(`No connector "${args.connector}" here.`, true);
        const isRead =
          READ_METHODS.has(args.method) ||
          connector.readPaths.includes(`${args.method} ${args.path}`);
        // After untrusted data, a read that sends something could carry it out (ADR 20).
        const { untrusted } = currentTurn();
        const carries = untrusted !== undefined && sendsSomething(args);
        if (isRead && !carries) return runCall(connector, args, secrets, room.id);
        try {
          const approval = await api.commit(
            (tx) =>
              requestApproval(
                tx,
                room.id,
                {
                  extension: "connectors",
                  kind: "call",
                  summary: carries
                    ? `${args.method} ${connector.name}${withQuery(args.path, args.query)}` +
                      (args.body === undefined ? "" : ` with ${args.body.slice(0, 300)}`) +
                      ` (after reading ${untrusted.join(", ")}: it could carry what the conversation holds)`
                    : `${args.method} ${connector.name}${args.path}`,
                  // The handler has no document access of its own, so the connector it needs
                  // (everything but the secret, which stays in its own store) travels with it.
                  payload: { roomId: room.id, connector, args },
                },
                now(),
              ),
            context,
          );
          return {
            ...text(`Waiting for approval ${approval.id}.`),
            details: { approval: approval.id },
          };
        } catch (error) {
          return text((error as Error).message, true);
        }
      },
    });

    const docsTool = defineTool({
      name: "connector_docs",
      description:
        "Search a connector's OpenAPI docs for operations, or look up one by method and path.",
      parameters: Type.Object({
        connector: Type.String(),
        search: Type.Optional(Type.String({ description: "Words to search for." })),
        operation: Type.Optional(Type.Object({ method: Type.String(), path: Type.String() })),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        const connectors = await visibleConnectors(api, room.id, context);
        const connector = connectors.find((c) => c.id === args.connector);
        if (connector === undefined) return text(`No connector "${args.connector}" here.`, true);
        if (connector.docsUrl === undefined)
          return text(`${connector.name} has no docs URL set.`, true);
        try {
          const spec = await fetchSpec(connector.docsUrl, specCache);
          if (args.operation !== undefined) {
            const described = describeOperation(spec, args.operation.method, args.operation.path);
            return described === undefined
              ? text(`No ${args.operation.method} ${args.operation.path} in the docs.`, true)
              : text(described);
          }
          const results = searchOperations(spec, args.search ?? "");
          return text(results.length === 0 ? "No matching operations." : results.join("\n"));
        } catch (error) {
          return text((error as Error).message, true);
        }
      },
    });

    return {
      tools: [
        addTool,
        updateTool,
        removeTool,
        // Scripts may read through a connector, never change something there.
        // What an API answers, and its docs, are written elsewhere: data to the model (ADR 20).
        returnsUntrusted(readsOnly(callTool, (args) => READ_METHODS.has(String(args.method)))),
        returnsUntrusted(readsOnly(docsTool)),
      ],
      roomSocket: panels.roomSocket,
      sections: [
        section("connectors", async (input, context) => {
          const room = await roomOf(input.read, input.conversationId, context);
          const connectors = await visibleConnectors(input.read, room.id, context);
          return connectorsSection(connectors, (c) => secrets.get(room.id, c.id) !== undefined);
        }),
      ],
      approvals: {
        add: async (payload, run) => {
          const draft = payload as {
            name: string;
            baseUrl: string;
            useFor: string;
            alwaysFirst?: boolean;
            docsUrl?: string;
            headers?: Record<string, string>;
            auth?: Connector["auth"];
          };
          const addedBy = run.approval.decidedBy?.displayName ?? "someone";
          try {
            const connector = await run.commit((tx) =>
              addConnector(tx, run.room.id, draft, addedBy, now()),
            );
            void panels.changed(run.room.id);
            const key = connector.auth
              ? " It needs an API key: someone in the room sets it on the web app's Connectors page, or " +
                "with /connector-key in a terminal chat."
              : "";
            return { text: `Added connector ${connector.id} (${connector.name}).${key}` };
          } catch (error) {
            return { text: (error as Error).message, isError: true };
          }
        },
        updateBaseUrl: async (payload, run) => {
          const { connector: id, baseUrl } = payload as { connector: string; baseUrl: string };
          try {
            const updated = await run.commit((tx) =>
              updateConnector(tx, run.room.id, id, { baseUrl }),
            );
            void panels.changed(run.room.id);
            return { text: `Connector ${updated.id}'s address is now ${updated.baseUrl}.` };
          } catch (error) {
            return { text: (error as Error).message, isError: true };
          }
        },
        rule: async (payload, run) => {
          const { connector: id, ...rule } = payload as {
            connector: string;
            useFor?: string;
            alwaysFirst?: boolean;
          };
          try {
            const updated = await run.commit((tx) => updateConnector(tx, run.room.id, id, rule));
            void panels.changed(run.room.id);
            return {
              text: updated.alwaysFirst
                ? `Connector ${updated.id} now comes first for: ${updated.useFor}`
                : `Connector ${updated.id} no longer comes first.`,
            };
          } catch (error) {
            return { text: (error as Error).message, isError: true };
          }
        },
        call: async (payload) => {
          const { roomId, connector, args } = payload as {
            roomId: string;
            connector: Connector;
            args: { method: string; path: string; query?: Record<string, string>; body?: string };
          };
          const outcome = await runCall(connector, args, secrets, roomId);
          return { text: resultText(outcome), isError: outcome.isError, untrusted: "call_api" };
        },
      },
    };
  },
});

/** Whether a call sends something besides its path: a query, a body, or a query in the path. */
function sendsSomething(args: { path: string; query?: Record<string, string>; body?: string }) {
  return (
    Object.keys(args.query ?? {}).length > 0 ||
    (args.body !== undefined && args.body !== "") ||
    args.path.includes("?")
  );
}

/** A path with its query, as the call would send it. */
function withQuery(path: string, query: Record<string, string> | undefined): string {
  const params = new URLSearchParams(query ?? {}).toString();
  return params === "" ? path : `${path}${path.includes("?") ? "&" : "?"}${params}`;
}

/** What an approval to change which connector comes first, or for what, asks. */
function ruleSummary(
  connector: Connector,
  rule: { useFor?: string; alwaysFirst?: boolean },
): string {
  const useFor = rule.useFor ?? connector.useFor;
  if (rule.alwaysFirst === false)
    return (
      `Stop using "${connector.name}" first` +
      (rule.useFor === undefined ? "" : `, and use it for: ${rule.useFor}`)
    );
  if (rule.alwaysFirst === true) return `Always use "${connector.name}" first for: ${useFor}`;
  return `Always use "${connector.name}" first for: ${useFor} (was: ${connector.useFor})`;
}

/** The connectors section: the ones people asked to come first, then the rest. */
export function connectorsSection(
  connectors: readonly Connector[],
  hasKey: (connector: Connector) => boolean,
): string | undefined {
  if (connectors.length === 0) return undefined;
  const line = (c: Connector) =>
    `- ${c.id} ${c.name}: ${c.useFor}` +
    (c.notes ? ` (notes: ${c.notes})` : "") +
    (c.auth && !hasKey(c) ? " (no API key set yet)" : "");
  const first = connectors.filter((c) => c.alwaysFirst === true);
  const rest = connectors.filter((c) => c.alwaysFirst !== true);
  const parts: string[] = [];
  if (first.length > 0)
    parts.push(
      "APIs the people here asked you to always use first. When a task matches one, call it " +
        "before browsing, searching, other tools or your own knowledge, and fall back to those " +
        "only when it fails or doesn't have the answer (say so when you do):\n" +
        first.map(line).join("\n"),
    );
  if (rest.length > 0)
    parts.push(
      (first.length > 0 ? "Other APIs" : "APIs") +
        " this conversation can call — prefer one of these over browsing or your own " +
        "knowledge when a task matches:\n" +
        rest.map(line).join("\n"),
    );
  return parts.join("\n\n");
}

/** The text of a tool-shaped result, for approval outcomes (which take `{ text, isError? }`). */
function resultText(result: { output: readonly { text: string }[] }): string {
  return result.output.map((part) => part.text).join("\n");
}

async function runCall(
  connector: Connector,
  args: { method: string; path: string; query?: Record<string, string>; body?: string },
  secrets: { get(scope: string, name: string): string | undefined },
  roomId: string,
) {
  const text = (value: string, isError = false) => ({
    output: [{ type: "text" as const, text: value }],
    ...(isError ? { isError } : {}),
  });
  try {
    const url = lockedUrl(connector, args.path, args.query);
    const headers: Record<string, string> = { ...connector.headers };
    const secretValue = connector.auth ? secrets.get(roomId, connector.id) : undefined;
    if (connector.auth && secretValue === undefined)
      return text(
        `${connector.name} needs an API key; ask the user to set one for it in the web app.`,
        true,
      );
    if (connector.auth && secretValue !== undefined) {
      const value = `${connector.auth.prefix ?? ""}${secretValue}`;
      if (connector.auth.in === "header") headers[connector.auth.name] = value;
      else url.searchParams.set(connector.auth.name, value);
    }
    const response = await fetchLocked(connector, url, {
      method: args.method,
      headers,
      ...(args.body === undefined ? {} : { body: args.body }),
    });
    const scrubbed = scrubSecrets(response.body, [secretValue]);
    const summary = [
      `${response.status} ${connector.name}${args.path}`,
      ...Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`),
      "",
      scrubbed + (response.truncated ? "\n…(truncated; narrow the query)" : ""),
    ].join("\n");
    return { ...text(summary, response.status >= 400) };
  } catch (error) {
    return text(error instanceof ConnectorError ? error.message : (error as Error).message, true);
  }
}
