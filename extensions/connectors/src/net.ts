import { lookup } from "node:dns/promises";
import type { Connector } from "./model.ts";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 200_000;
const MAX_REDIRECTS = 5;

export class ConnectorError extends Error {
  override name = "ConnectorError";
}

/**
 * Builds the URL for one call: `path` (and `query`) resolved against the connector's `baseUrl`,
 * refused if that lands outside the connector's own origin. `path` may not be an absolute URL to
 * somewhere else — that would otherwise let a call silently leave the connector it claims to use.
 */
export function lockedUrl(
  connector: Pick<Connector, "baseUrl" | "name">,
  path: string,
  query?: Readonly<Record<string, string>>,
): URL {
  const base = new URL(connector.baseUrl);
  let url: URL;
  try {
    url = new URL(path, connector.baseUrl);
  } catch {
    throw new ConnectorError(`"${path}" is not a valid path`);
  }
  if (url.origin !== base.origin)
    throw new ConnectorError(`"${path}" leaves ${connector.name}'s address; calls stay on it`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

/**
 * Hosts on this machine or the local network, by name. Resolved addresses are checked separately
 * by `assertReachable`; this alone would miss a name that only resolves to a private address.
 */
export function isPrivateHostname(host: string): boolean {
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    name === "" ||
    name === "localhost" ||
    /\.(localhost|local|internal|lan|home\.arpa)$/.test(name) ||
    isPrivateAddress(name)
  );
}

/** A literal IPv4 or IPv6 address in a private, loopback or link-local range. */
export function isPrivateAddress(address: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (address.includes(":")) {
    if (address === "::1" || address === "::") return true;
    if (/^(fc|fd)/i.test(address) || /^fe[89ab]/i.test(address)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  return false;
}

/**
 * Refuses a host on this machine or the local network, unless `allowPrivateNetwork`. Checks the
 * hostname itself and every address it resolves to, so a name that only *looks* public but
 * resolves to a private address (DNS rebinding) is still caught. The resolved address is not
 * pinned for the connection itself, so a DNS answer that changes between this check and the
 * actual request is a known, narrow gap — fine for a connector a person chose to add, not a
 * defence against an adversarial DNS server.
 */
export async function assertReachable(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  if (allowPrivateNetwork) return;
  if (isPrivateHostname(url.hostname))
    throw new ConnectorError(
      `${url.hostname} is a local address; turn on allowPrivateNetwork to reach it`,
    );
  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new ConnectorError(`Could not resolve ${url.hostname}: ${(error as Error).message}`);
  }
  for (const { address } of addresses)
    if (isPrivateAddress(address))
      throw new ConnectorError(`${url.hostname} resolves to a local address (${address})`);
}

export type FetchedResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated: boolean;
};

/** Response headers worth showing the model; the rest add noise without adding information. */
const USEFUL_HEADERS = new Set([
  "content-type",
  "content-length",
  "location",
  "retry-after",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

/**
 * Fetches `url`, following same-origin redirects by hand (each hop re-checked for the private
 * network rule), with a timeout and a response size cap. Throws `ConnectorError` for anything that
 * stops the call before a response — the private network rule, a redirect leaving the connector's
 * origin, too many redirects, a timeout, or a network error.
 */
export async function fetchLocked(
  connector: Pick<Connector, "baseUrl" | "name" | "allowPrivateNetwork">,
  url: URL,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
  },
  options: { readonly timeoutMs?: number; readonly maxBytes?: number } = {},
): Promise<FetchedResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const base = new URL(connector.baseUrl);
  let current = url;
  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) throw new ConnectorError("Too many redirects");
    await assertReachable(current, connector.allowPrivateNetwork);
    let response: Response;
    try {
      response = await fetch(current, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ConnectorError(
        error instanceof DOMException && error.name === "TimeoutError"
          ? `${connector.name} did not answer in time`
          : `Could not reach ${connector.name}: ${(error as Error).message}`,
      );
    }
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      const next = new URL(response.headers.get("location")!, current);
      if (next.origin !== base.origin)
        throw new ConnectorError(`${connector.name} redirected outside its own address`);
      current = next;
      continue;
    }
    return readBody(response, maxBytes);
  }
}

async function readBody(response: Response, maxBytes: number): Promise<FetchedResponse> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, maxBytes - total)));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  }
  const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers)
    if (USEFUL_HEADERS.has(key.toLowerCase())) headers[key] = value;
  return { status: response.status, headers, body, truncated };
}
