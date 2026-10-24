import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAUNCHER = join(import.meta.dirname, "..", "bin", "nudge-server");

/**
 * The launcher, run with stand-in releases: each one's `node` is a shell script that notes the
 * run in `$NUDGE_HOME/runs` and then does `script`, as a release's server would (exit, install an
 * update, confirm itself).
 */
describe("nudge-server", () => {
  let home: string;
  let releases: string;

  const release = async (dir: string, version: string, script: string) => {
    await mkdir(join(dir, "bin"), { recursive: true });
    await mkdir(join(dir, "node", "bin"), { recursive: true });
    await writeFile(join(dir, "VERSION"), `${version}\n`);
    await copyFile(LAUNCHER, join(dir, "bin", "nudge-server"));
    const node = join(dir, "node", "bin", "node");
    await writeFile(
      node,
      `#!/bin/sh\necho "$NUDGE_VERSION $2 $3 $4" >>"$NUDGE_HOME/runs"\nreleases=$NUDGE_RELEASES\n${script}\n`,
    );
    await chmod(node, 0o755);
  };
  /** What an installed update leaves: `version` unpacked, `pending` and `current` pointed at it. */
  const update = (version: string, script: string) =>
    `mkdir -p "$releases/${version}/node/bin" "$releases/${version}/bin"
echo ${version} >"$releases/${version}/VERSION"
cat >"$releases/${version}/node/bin/node" <<'EOF'
#!/bin/sh
echo "$NUDGE_VERSION $2 $3 $4" >>"$NUDGE_HOME/runs"
releases=$NUDGE_RELEASES
${script}
EOF
chmod +x "$releases/${version}/node/bin/node"
basename "$(readlink "$releases/current")" >"$releases/pending"
ln -sfn ${version} "$releases/current"
exit 75`;
  const run = (launcher = join(home, "image", "bin", "nudge-server")) => {
    const result = spawnSync("sh", [launcher, "--port", "1"], {
      env: { PATH: process.env.PATH, NUDGE_HOME: home },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { code: result.status, stderr: result.stderr };
  };
  const runs = () => readFileSync(join(home, "runs"), "utf8").trim().split("\n");
  const current = () => readlink(join(releases, "current"));

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "nudge-server-"));
    releases = join(home, "releases");
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it("takes in the release it came with, and runs it with the arguments it got", async () => {
    await release(join(home, "image"), "0.1.0", "exit 0");
    expect(run().code).toBe(0);
    expect(await current()).toBe("0.1.0");
    expect(readFileSync(join(releases, "0.1.0", "VERSION"), "utf8").trim()).toBe("0.1.0");
    expect(runs()).toEqual(["0.1.0 serve --port 1"]);
  });

  it("takes in a newer image's release, but not an older one's", async () => {
    await release(join(releases, "0.2.0"), "0.2.0", "exit 0");
    await symlink("0.2.0", join(releases, "current"));
    await release(join(home, "image"), "0.1.0", "exit 0");
    run();
    expect(await current()).toBe("0.2.0");

    await rm(join(home, "image"), { recursive: true });
    await release(join(home, "image"), "0.3.0", "exit 0");
    run();
    expect(await current()).toBe("0.3.0");
    expect(runs()).toEqual(["0.2.0 serve --port 1", "0.3.0 serve --port 1"]);
  });

  it("starts an installed update, and rolls it back when it stops before confirming", async () => {
    await release(
      join(home, "image"),
      "0.1.0",
      `[ -e "$NUDGE_HOME/updated" ] && exit 0\ntouch "$NUDGE_HOME/updated"\n${update("0.2.0", "exit 3")}`,
    );
    const { code, stderr } = run();
    expect(code).toBe(0);
    expect(runs()).toEqual([
      "0.1.0 serve --port 1",
      "0.2.0 serve --port 1",
      "0.1.0 serve --port 1",
    ]);
    expect(stderr).toMatch(/0\.2\.0 stopped with 3 before it was healthy; back to 0\.1\.0/);
    expect(await current()).toBe("0.1.0");
    expect(readFileSync(join(releases, "failed"), "utf8")).toBe("0.2.0\n");
    expect(existsSync(join(releases, "pending"))).toBe(false);
  });

  it("rolls back an update that stops before confirming, even without an error", async () => {
    await release(
      join(home, "image"),
      "0.1.0",
      `[ -e "$NUDGE_HOME/updated" ] && exit 0\ntouch "$NUDGE_HOME/updated"\n${update("0.2.0", "exit 0")}`,
    );
    expect(run().code).toBe(0);
    expect(await current()).toBe("0.1.0");
  });

  it("keeps an update that confirmed itself, whatever it does after", async () => {
    // As one that moved the data to a newer format does before it moves it.
    await release(join(home, "image"), "0.1.0", update("0.2.0", 'rm "$releases/pending"\nexit 3'));
    expect(run().code).toBe(3);
    expect(runs()).toEqual(["0.1.0 serve --port 1", "0.2.0 serve --port 1"]);
    expect(await current()).toBe("0.2.0");
    expect(existsSync(join(releases, "failed"))).toBe(false);
  });
});
