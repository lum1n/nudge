import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.ts";
import type { V1Options } from "../src/v1/routes.ts";

const DOC = readFileSync(new URL("../../../docs/protocol/v1.md", import.meta.url), "utf8");

/**
 * Routes registered for every method, which are no endpoints of their own: the authentication
 * middleware of an assistant's and the server's routes, the rate limits (on everything, and the
 * stricter ones on the routes that take a code), and the hand-off to extensions' routes.
 * Those are the extensions' own; the doc speaks of them in general, and of the bundled ones' in
 * their sections, but nothing here lists them. A new route for every method fails the test until
 * it is added here, with a reason.
 */
const NOT_ENDPOINTS = [
  "ALL /v1/*",
  "ALL /v1/a/:assistant/pair",
  "ALL /v1/setup",
  "ALL /v1/setup/*",
  "ALL /v1/sign-in",
  "ALL /v1/server/*",
  "ALL /v1/a/:assistant/*",
  "ALL /v1/a/:assistant/ext/:extension",
  "ALL /v1/a/:assistant/ext/:extension/*",
];

/** Every route, with the server API and setup mode on; the stand-ins are never called. */
function registeredRoutes(): string[] {
  const app = createApp({
    assistants: new Map(),
    server: {} as V1Options["server"],
    setup: {} as V1Options["setup"],
  });
  return [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))];
}

/**
 * The routes the doc names, as `METHOD /path` in code, made absolute: the doc writes the server's
 * and setup's paths under `/v1`, and the rest under `/v1/a/<assistant>`, unless it gives `/v1/…`.
 */
function documentedRoutes(): Set<string> {
  const found = new Set<string>();
  for (const [, method, path] of DOC.matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/[^`\s?]*)/g)) {
    const absolute = path!.startsWith("/v1")
      ? path!
      : /^\/(server|setup)(\/|$)/.test(path!)
        ? `/v1${path}`
        : `/v1/a/<assistant>${path}`;
    found.add(normalize(`${method} ${absolute}`));
  }
  return found;
}

/** Parameters by position only, since the doc names them for people and the code for itself. */
const normalize = (route: string) => route.replace(/:\w+|<[^>]+>/g, ":").replace(/\/$/, "");

describe("docs/protocol/v1.md", () => {
  it("documents every route the server registers", () => {
    const routes = registeredRoutes();
    expect(routes.filter((route) => route.startsWith("ALL ")).sort()).toEqual(
      [...NOT_ENDPOINTS].sort(),
    );
    const documented = documentedRoutes();
    const missing = routes.filter(
      (route) => !NOT_ENDPOINTS.includes(route) && !documented.has(normalize(route)),
    );
    expect(missing, "routes docs/protocol/v1.md doesn't mention").toEqual([]);
  });

  it("names no route the server doesn't have, outside extensions", () => {
    const routes = new Set(registeredRoutes().map(normalize));
    const stale = [...documentedRoutes()].filter(
      (route) => !route.includes("/ext/") && !routes.has(route),
    );
    expect(stale, "routes docs/protocol/v1.md names that the server doesn't register").toEqual([]);
  });
});
