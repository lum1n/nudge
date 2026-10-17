#!/usr/bin/env node
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { loadRelayConfig } from "./config.ts";
import { relayApp } from "./relay.ts";

const USAGE = `Usage: nudge-relay [options]

Runs the push relay: apps register their device for a handle, and Nudge hosts push to them
through it, sealed for the device.

Options:
  -c, --config <file>  The relay's config (default: relay.json)
      --port <port>    Port (default: 8790)
      --host <host>    Interface (default: 127.0.0.1; put a TLS proxy in front)
  -h, --help           Show this`;

const { values } = parseArgs({
  options: {
    config: { type: "string", short: "c", default: "relay.json" },
    port: { type: "string", default: "8790" },
    host: { type: "string", default: "127.0.0.1" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`--port ${values.port} is not a port`);
  process.exit(2);
}
let options;
try {
  options = loadRelayConfig(values.config);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const app = relayApp(options);
const server = serve({ fetch: app.fetch, port, hostname: values.host }, (info: AddressInfo) => {
  const sends = [options.apns && "APNs", options.fcm && "FCM"].filter(Boolean).join(" and ");
  console.log(`Relay at http://${info.address}:${info.port}, sending ${sends || "nothing"}`);
});
const stop = () => {
  options.apns?.close();
  server.close(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
