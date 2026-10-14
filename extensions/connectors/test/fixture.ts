import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A small JSON API for the connector tests: echoes, redirects, a slow route, a big route. */
export function fixture(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/echo") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () =>
        json(200, {
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          authorization: req.headers.authorization ?? null,
          apiKey: req.headers["x-api-key"] ?? null,
          body,
        }),
      );
      return;
    }
    if (url.pathname === "/redirect-ok") return json(302, {}, { location: "/echo" });
    if (url.pathname === "/redirect-away")
      return json(302, {}, { location: "http://evil.example/echo" });
    if (url.pathname === "/slow") {
      setTimeout(() => json(200, { ok: true }), 2000);
      return;
    }
    if (url.pathname === "/big") return json(200, { data: "x".repeat(1_000_000) });
    if (url.pathname === "/text") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json");
      return;
    }
    if (url.pathname === "/openapi.json")
      return json(200, {
        openapi: "3.0.0",
        paths: {
          "/forecast": {
            get: {
              summary: "Get a weather forecast",
              operationId: "getForecast",
              parameters: [
                { name: "lat", in: "query", required: true, schema: { type: "number" } },
                { name: "lon", in: "query", required: true, schema: { type: "number" } },
              ],
            },
          },
          "/alerts": {
            post: {
              summary: "Create an alert",
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Alert" },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Alert: { type: "object", properties: { message: { type: "string" } } },
          },
        },
      });
    json(404, { error: "not found" });
  });
}

/** Starts `server` on an ephemeral port and resolves its base URL. */
export async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
