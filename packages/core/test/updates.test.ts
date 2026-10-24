import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, checkManifest, confirmWhenHealthy, newer, Updates } from "../src/index.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64");

function signed(manifest: Record<string, unknown>, key = privateKey) {
  const signature = sign(null, Buffer.from(canonicalJson(manifest)), key).toString("base64");
  return { ...manifest, signature };
}

describe("release manifests", () => {
  it("are checked against the release keys, whatever order their keys come in", () => {
    const manifest = signed({
      nudge: "release",
      version: "0.2.0",
      publishedAt: "x",
      artifacts: {},
    });
    expect(checkManifest(manifest, [KEY])?.version).toBe("0.2.0");
    const reordered = JSON.parse(JSON.stringify({ artifacts: {}, ...manifest }));
    expect(checkManifest(reordered, [KEY])).toBeDefined();
    expect(checkManifest({ ...manifest, version: "9.9.9" }, [KEY])).toBeUndefined();
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(
      checkManifest(signed({ nudge: "release", version: "1", artifacts: {} }, other), [KEY]),
    ).toBeUndefined();
    expect(checkManifest(manifest, [])).toBeUndefined();
  });

  it("compare versions by their numbers, a pre-release before its release", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("0.2.0", "0.2.0")).toBe(false);
    expect(newer("0.2.0", "0.2.0-beta.1")).toBe(true);
    expect(newer("0.2.0-beta.2", "0.2.0-beta.1")).toBe(true);
    expect(newer("v1.0.0", "0.99.0")).toBe(true);
    expect(newer("0.1.9", "0.2.0")).toBe(false);
  });
});

describe("Updates", () => {
  let dir: string;
  let releases: string;
  const served = new Map<string, Buffer | string>();
  const fetcher: typeof fetch = async (input) => {
    const body = served.get(String(input));
    return body === undefined
      ? new Response("no", { status: 404 })
      : new Response(typeof body === "string" ? body : new Uint8Array(body));
  };

  /** A release archive as bundle.sh makes it, with a VERSION and bin/nudge-server. */
  const archive = async (version: string) => {
    const root = join(dir, "build", `nudge-${version}-linux-x64`);
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "VERSION"), `${version}\n`);
    await writeFile(join(root, "bin", "nudge-server"), "#!/bin/sh\n");
    const file = join(dir, "build", `nudge-${version}.tar.gz`);
    execFileSync("tar", ["-czf", file, "-C", join(dir, "build"), `nudge-${version}-linux-x64`]);
    return readFileSync(file);
  };
  const publish = async (version: string, tamper = false) => {
    const bytes = await archive(version);
    served.set(`https://r.example/nudge-${version}.tar.gz`, bytes);
    const sha256 = createHash("sha256")
      .update(tamper ? "else" : bytes)
      .digest("hex");
    served.set(
      "https://r.example/manifest.json",
      JSON.stringify(
        signed({
          nudge: "release",
          version,
          publishedAt: "now",
          artifacts: { "linux-x64": { url: `https://r.example/nudge-${version}.tar.gz`, sha256 } },
        }),
      ),
    );
  };
  const updates = (current: string) =>
    new Updates({
      releasesDir: releases,
      current,
      platform: "linux-x64",
      manifestUrl: "https://r.example/manifest.json",
      keys: [KEY],
      fetch: fetcher,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-updates-"));
    releases = join(dir, "releases");
    await mkdir(join(releases, "0.1.0"), { recursive: true });
    await symlink("0.1.0", join(releases, "current"));
    served.clear();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("installs a newer signed release beside the running one, to be confirmed", async () => {
    await publish("0.2.0");
    const running = updates("0.1.0");
    const release = await running.check();
    expect(release?.version).toBe("0.2.0");
    expect(running.state(true)).toMatchObject({ current: "0.1.0", available: "0.2.0" });
    await running.install(release!);
    expect(await readlink(join(releases, "current"))).toBe("0.2.0");
    expect(readFileSync(join(releases, "0.2.0", "VERSION"), "utf8").trim()).toBe("0.2.0");
    expect(readFileSync(join(releases, "pending"), "utf8")).toBe("0.1.0");

    expect(running.unconfirmed()).toBe(false);
    expect(updates("0.2.0").unconfirmed()).toBe(true);

    // The new one confirms itself, and keeps the one before it to go back to.
    await mkdir(join(releases, "0.0.9"));
    await updates("0.2.0").confirm();
    expect(updates("0.2.0").unconfirmed()).toBe(false);
    expect(existsSync(join(releases, "pending"))).toBe(false);
    expect(existsSync(join(releases, "0.1.0"))).toBe(true);
    expect(existsSync(join(releases, "0.0.9"))).toBe(false);
  });

  it("refuses a release whose archive isn't the one signed", async () => {
    await publish("0.2.0", true);
    const running = updates("0.1.0");
    await expect(running.install((await running.check())!)).rejects.toThrow(/hash/);
    expect(await readlink(join(releases, "current"))).toBe("0.1.0");
    expect(existsSync(join(releases, "0.2.0"))).toBe(false);
  });

  it("skips what isn't newer, failed here before, or unsigned", async () => {
    await publish("0.1.0");
    expect(await updates("0.1.0").check()).toBeUndefined();
    await publish("0.2.0");
    await writeFile(join(releases, "failed"), "0.2.0\n");
    expect(await updates("0.1.0").check()).toBeUndefined();
    served.set("https://r.example/manifest.json", JSON.stringify({ nudge: "release" }));
    const running = updates("0.1.0");
    expect(await running.check()).toBeUndefined();
    expect(running.state(true).error).toMatch(/signed/);
  });
});

describe("confirmWhenHealthy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const watch = (answers: boolean[], unconfirmed = true) => {
    const seen = { probes: 0, confirmed: 0, gaveUp: 0, said: [] as string[] };
    const stop = confirmWhenHealthy({
      probe: async () => answers[seen.probes++] ?? false,
      confirm: async () => void seen.confirmed++,
      unconfirmed: () => unconfirmed,
      giveUp: () => void seen.gaveUp++,
      say: (line) => seen.said.push(line),
      afterMs: 30_000,
      everyMs: 10_000,
      withinMs: 60_000,
    });
    return { seen, stop };
  };

  it("confirms once the health check answers well, not before", async () => {
    const { seen } = watch([false, false, true]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(seen.probes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toMatchObject({ probes: 1, confirmed: 0 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(seen).toMatchObject({ probes: 3, confirmed: 1, gaveUp: 0 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(seen.probes).toBe(3);
  });

  it("gives up on an update that isn't healthy in time, so it is rolled back", async () => {
    const { seen } = watch([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toMatchObject({ probes: 4, confirmed: 0, gaveUp: 1 });
    expect(seen.said[0]).toMatch(/Not healthy 60 s after starting/);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(seen.probes).toBe(4);
  });

  it("leaves a release that was already kept running, healthy or not", async () => {
    const { seen } = watch([], false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(seen).toMatchObject({ confirmed: 0, gaveUp: 0 });
  });

  it("does nothing once stopped", async () => {
    const { seen, stop } = watch([true]);
    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(seen.probes).toBe(0);
  });
});
