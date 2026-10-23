import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A remote MCP server behind OAuth for the tests, with its own authorization server: discovery,
 * dynamic registration, PKCE and a token. Its sign-in page agrees at once, sending the browser
 * back with the code. `/mcp` answers 401 until it gets the token, then has one read-only tool,
 * `search`.
 */
export async function fakeOAuthServer(): Promise<{ url: string; close(): Promise<void> }> {
  let base = "";
  const TOKEN = "good-token";
  const read = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => resolve(body));
    });
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", "the-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: String(back) });
      return response.end();
    }
    if (url.pathname === "/register" && request.method === "POST")
      return json(201, { ...JSON.parse(await read(request)), client_id: "nudge-client" });
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await read(request));
      if (form.get("code") !== "the-code" || !form.get("code_verifier"))
        return json(400, { error: "invalid_grant" });
      return json(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname !== "/mcp") return json(404, { error: "not found" });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
      return response.end();
    }
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 200 : 405);
      return response.end();
    }
    const message = JSON.parse(await read(request)) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string; arguments?: { query?: string } };
    };
    if (message.id === undefined) {
      response.writeHead(202);
      return response.end();
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake-oauth", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "search",
                  description: "Search the docs",
                  inputSchema: { type: "object", properties: { query: { type: "string" } } },
                  annotations: { readOnlyHint: true },
                },
              ],
            }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: `Found ${message.params?.arguments?.query}.` }] }
            : {};
    json(200, { jsonrpc: "2.0", id: message.id, result });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${base}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
