import { defineWebSocketHelper, WSContext } from "hono/ws";

/**
 * Hono's WebSocket upgrade for workerd. Unlike `hono/cloudflare-workers`'s, it calls `onOpen`,
 * which protocol v1's routes start each connection in: a socket is open once it is accepted.
 */
export const upgradeWebSocket = defineWebSocketHelper(async (c, events) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return;
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  const ws = new WSContext<WebSocket>({
    send: (data) => server.send(data),
    close: (code, reason) => server.close(code, reason),
    raw: server,
    get readyState() {
      return server.readyState as WSContext["readyState"];
    },
    get protocol() {
      return server.protocol;
    },
    url: server.url ? new URL(server.url) : null,
  });
  server.addEventListener("message", (event) => events.onMessage?.(event, ws));
  server.addEventListener("close", (event) => events.onClose?.(event, ws));
  server.addEventListener("error", (event) => events.onError?.(event, ws));
  server.accept();
  events.onOpen?.(new Event("open"), ws);
  return new Response(null, { status: 101, webSocket: client });
});
