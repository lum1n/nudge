import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR 1: only @nudge/core touches Pi, so a Pi upgrade touches only it. Everything else takes what
// it needs from @nudge/core and its entry points.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const PI = /["']@earendil-works\//;

function packages(): string[] {
  return ["apps", "packages", "extensions"]
    .flatMap((dir) => readdirSync(join(root, dir)).map((name) => join(root, dir, name)))
    .filter((path) => path !== join(root, "packages", "core"));
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
      return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

describe("the Pi boundary", () => {
  it("keeps Pi packages out of every package but core", () => {
    const offenders = packages().flatMap((dir) => {
      const manifest = read(join(dir, "package.json"));
      if (manifest === undefined) return [];
      const { dependencies, devDependencies, peerDependencies } = JSON.parse(manifest);
      const deps = Object.keys({ ...dependencies, ...devDependencies, ...peerDependencies }).filter(
        (name) => name.startsWith("@earendil-works/"),
      );
      const files = sources(dir).filter((file) => PI.test(readFileSync(file, "utf8")));
      return [
        ...deps.map((name) => `${relative(root, dir)}: ${name}`),
        ...files.map((file) => relative(root, file)),
      ];
    });
    expect(offenders).toEqual([]);
  });
});
