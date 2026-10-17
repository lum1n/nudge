// Writes a release's manifest.json, signed with the release key (ADR 11):
//   NUDGE_RELEASE_KEY="$(cat key.pem)" node sign.mjs <version> <dir> <url of the release's files>
// <dir> holds nudge-<version>-linux-<arch>.tar.gz for each architecture. Servers read the
// manifest, check its signature against RELEASE_KEYS, and the archive against its sha256.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [version, dir, base] = process.argv.slice(2);
if (version === undefined || dir === undefined || base === undefined) {
  console.error("Usage: sign.mjs <version> <dir> <base url>");
  process.exit(2);
}
const key = process.env.NUDGE_RELEASE_KEY;
if (!key) {
  console.error("Set NUDGE_RELEASE_KEY to the release key (PEM)");
  process.exit(2);
}

/** As `canonicalJson` in @nudge/core: keys sorted at every level. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, item]) => `${JSON.stringify(k)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const artifacts = {};
const pattern = new RegExp(`^nudge-${version.replace(/\./g, "\\.")}-(linux-[a-z0-9]+)\\.tar\\.gz$`);
for (const name of (await readdir(dir)).sort()) {
  const platform = pattern.exec(name)?.[1];
  if (platform === undefined) continue;
  const file = join(dir, name);
  artifacts[platform] = {
    url: `${base.replace(/\/+$/, "")}/${name}`,
    sha256: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
    size: (await stat(file)).size,
  };
}
if (Object.keys(artifacts).length === 0) {
  console.error(`No nudge-${version}-linux-*.tar.gz in ${dir}`);
  process.exit(1);
}
const manifest = { nudge: "release", version, publishedAt: new Date().toISOString(), artifacts };
const signature = sign(null, Buffer.from(canonicalJson(manifest)), createPrivateKey(key));
await writeFile(
  join(dir, "manifest.json"),
  `${JSON.stringify({ ...manifest, signature: signature.toString("base64") }, null, 2)}\n`,
);
console.log(`Signed ${Object.keys(artifacts).join(", ")} into ${join(dir, "manifest.json")}`);
