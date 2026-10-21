import { PUBLIC_SUFFIXES, TLDS, WELL_KNOWN_DOMAINS } from "./lists/domains.ts";
import type { PiiDetector, Span } from "./detectors.ts";

/** Public services a Norwegian household uses that the top list may not have. */
const PUBLIC_EXTRA = [
  "altinn.no",
  "atb.no",
  "banenor.no",
  "bankid.no",
  "entur.no",
  "flytoget.no",
  "kartverket.no",
  "kolumbus.no",
  "met.no",
  "norge.no",
  "regjeringen.no",
  "ruter.no",
  "skyss.no",
  "ssb.no",
  "vipps.no",
];

const tlds = new Set(TLDS);
const suffixes = new Set(PUBLIC_SUFFIXES);
const wellKnown = new Set([...WELL_KNOWN_DOMAINS, ...PUBLIC_EXTRA]);
/**
 * Top-level domains that are also file extensions or field names in code (`README.md`,
 * `index.ts`, `item.id`): these count as a host only after a scheme or before a path.
 */
const CODE_TLDS = new Set(
  "ai as at by cc cs do go id in is it md ml mov pl pm ps py rs sc sh so tf to ts zip app".split(
    " ",
  ),
);
/** Generic top-level domains a bare name counts with; the rest are mostly words in code. */
const COMMON_GTLDS = new Set(
  "com net org info biz dev io xyz cloud online site tech page blog me co eu".split(" "),
);
/** Hosts that are never public, whatever comes before them. */
const PRIVATE_SUFFIXES = ["local", "lan", "internal", "home.arpa", "localdomain", "ts.net"];

const HOST =
  /(?<![\p{L}\p{N}_@.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,23}[a-z0-9](?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])/giu;

/** Names kept for examples and tests (RFC 2606, 6761), which never belong to anyone. */
function isReserved(host: string): boolean {
  return (
    /(?:^|\.)example\.[a-z]+$/.test(host) || /\.(?:example|test|invalid|localhost)$/.test(host)
  );
}

/** The registrable part of a host: one label more than its public suffix, as in `kjeks.dev`. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const rest = labels.slice(i + 1).join(".");
    if (suffixes.has(rest) || suffixes.has(`*.${labels.slice(i + 2).join(".")}`))
      return labels.slice(i).join(".");
  }
  return labels.slice(-2).join(".");
}

/** Whether a host is public enough to leave readable: a well-known site or one of its subdomains. */
export function isWellKnownHost(host: string): boolean {
  const lower = host.toLowerCase();
  return suffixes.has(lower) || wellKnown.has(registrableDomain(lower));
}

/**
 * Host names the model shouldn't see: home servers (`hass.kjeks.dev`, `box.local`, a tailnet's
 * `ts.net` names) and anyone's own domain. Well-known public sites (`yr.no`, `github.com`) stay
 * readable, though not personal subdomains of hosting suffixes such as `vegard.github.io`. A bare
 * name needs a real top-level domain; one that is also a file extension (`README.md`) needs a
 * scheme or a path.
 */
export const domainDetector: PiiDetector = {
  kind: "DOMAIN",
  *find(text) {
    for (const match of text.matchAll(HOST)) {
      const host = match[0];
      const lower = host.toLowerCase();
      const start = match.index;
      const end = start + host.length;
      const tld = lower.slice(lower.lastIndexOf(".") + 1);
      const isPrivate = PRIVATE_SUFFIXES.some((s) => lower === s || lower.endsWith(`.${s}`));
      if (!isPrivate && !tlds.has(tld)) continue;
      const schemed = /[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?$/i.test(text.slice(0, start));
      const pathed = text[end] === "/";
      if (!schemed && !isPrivate) {
        if (CODE_TLDS.has(tld) && !pathed) continue;
        if (tld.length > 2 && !COMMON_GTLDS.has(tld) && !pathed) continue;
        // `player.displayName` is code, not a host.
        if (/[a-z0-9][A-Z]/.test(host)) continue;
      }
      if (!isPrivate && (isWellKnownHost(lower) || isReserved(lower))) continue;
      yield { start, end };
    }
  },
};

const IPV4 = /(?<![\p{L}\p{N}.])(?:\d{1,3}\.){3}\d{1,3}(?![\p{N}]|\.\d)/gu;

/** IPv4 addresses, private and public; loopback, `0.0.0.0` and masks stay readable. */
export const ipDetector: PiiDetector = {
  kind: "IP",
  *find(text) {
    for (const match of text.matchAll(IPV4)) {
      const parts = match[0].split(".").map(Number);
      if (parts.some((part) => part > 255)) continue;
      if (parts[0] === 127 || parts[0] === 0 || parts[0] === 255) continue;
      if (/v$/i.test(text.slice(0, match.index))) continue; // v1.2.3.4
      yield { start: match.index, end: match.index + match[0].length };
    }
  },
};

/** User names that say nothing about anyone. */
const SYSTEM_USERS = new Set(
  "root user users ubuntu debian admin administrator runner nudge node git www-data nobody shared public default guest pi app ec2-user docker postgres".split(
    " ",
  ),
);
const USER = "[a-z_][a-z0-9_.-]{0,31}";
const USER_PATTERNS = [
  // /home/vegard, /Users/vegard, C:\Users\vegard
  new RegExp(`(?<=(?:^|[^\\p{L}\\p{N}])/(?:home|Users)/)${USER}(?![\\p{L}\\p{N}_-])`, "giu"),
  new RegExp(`(?<=\\b[A-Z]:\\\\Users\\\\)${USER}(?![\\p{L}\\p{N}_-])`, "giu"),
  // ~vegard/
  new RegExp(`(?<=(?:^|[\\s"'(=:])~)${USER}(?=/)`, "giu"),
  // vegard@box, ssh vegard@192.168.1.5 (an email is found as a whole first)
  new RegExp(
    `(?<![\\p{L}\\p{N}_.%+/-])${USER}(?=@(?!(?:latest|next|beta|canary|alpha|rc|types)\\b)(?:[a-z][a-z0-9.-]*|\\d{1,3}(?:\\.\\d{1,3}){3}))`,
    "giu",
  ),
];

/** User names in paths (`/home/vegard`, `C:\Users\vegard`, `~vegard/`) and in `user@host`. */
export const usernameDetector: PiiDetector = {
  kind: "USERNAME",
  *find(text) {
    const spans: Span[] = [];
    for (const pattern of USER_PATTERNS)
      for (const match of text.matchAll(pattern)) {
        const name = match[0].replace(/[.-]+$/, "");
        if (name.length < 2 || SYSTEM_USERS.has(name.toLowerCase())) continue;
        spans.push({ start: match.index, end: match.index + name.length });
      }
    yield* spans.sort((a, b) => a.start - b.start);
  },
};
