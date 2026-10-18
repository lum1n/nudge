#!/bin/sh
# Builds a Nudge server release for this machine's architecture (ADR 11):
#
#   dist/release/nudge-<version>-linux-<arch>.tar.gz
#     node/       Node, the release's own
#     app/        @nudge/release deployed with its production dependencies
#     bin/        nudge-server (the launcher) and nudge
#     tailscale/  Tailscale's static build, for the server's own Tailscale
#     wired-node/ Wired's Node binding (github.com/lum1n/wired), for the server's own Wired
#     chromium.json  where the release's Chromium is, and its sha256, with NUDGE_RELEASE_URL set
#     VERSION
#
#   dist/release/chromium-<version>-linux-<arch>.tar.gz, with NUDGE_RELEASE_URL set: the Chromium
#     the browser extension runs, as patchright installs it, to publish at that address
#
# Run on each architecture (x64, arm64): the SQLite module is native, built for the bundled Node.
#   packages/release/scripts/bundle.sh 0.1.0
set -eu

version=${1:?usage: bundle.sh <version>}
node_version=${NODE_VERSION:-24.22.0}
root=$(cd "$(dirname "$0")/../../.." && pwd)
case $(uname -m) in
  x86_64) arch=x64 tailscale_arch=amd64 ;;
  aarch64 | arm64) arch=arm64 tailscale_arch=arm64 ;;
  *) echo "Unsupported architecture $(uname -m)" >&2 && exit 1 ;;
esac
name=nudge-$version-linux-$arch
out=$root/dist/release
work=$out/$name
rm -rf "$work" "$out/$name.tar.gz"
mkdir -p "$work/node/bin" "$work/bin"

# Node first: the install below builds the SQLite module against it.
node_dist=node-v$node_version-linux-$arch
curl -fsSL "https://nodejs.org/dist/v$node_version/$node_dist.tar.xz" -o "$out/$node_dist.tar.xz"
curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" |
  grep " $node_dist.tar.xz\$" | (cd "$out" && sha256sum -c -)
tar -xJf "$out/$node_dist.tar.xz" -C "$out"
cp "$out/$node_dist/bin/node" "$work/node/bin/node"
cp "$out/$node_dist/LICENSE" "$work/node/LICENSE"
rm -rf "$out/$node_dist" "$out/$node_dist.tar.xz"

export PATH="$work/node/bin:$PATH"
pnpm -C "$root" -r --filter "./packages/*" --filter "./extensions/*" --filter "./apps/web" build
pnpm -C "$root" --filter @nudge/release deploy --legacy --prod --config.node-linker=hoisted \
  "$work/app"
# Deploying leaves the workspace marked as a production install; put the checkout back.
pnpm -C "$root" install --frozen-lockfile >/dev/null

# What only building needed.
sqlite=$work/app/node_modules/better-sqlite3-multiple-ciphers
rm -rf "$sqlite/deps" "$sqlite/src" "$sqlite/build/Release/obj.target" "$sqlite/build/deps"
# patchright's lib/mcp/test is code its CLI loads, which installs Chromium.
find "$work/app/node_modules" -type d \( -name test -o -name tests -o -name __tests__ \) \
  -not -path '*/node_modules/patchright/*' -prune -exec rm -rf {} +
"$work/node/bin/node" -e 'require(process.argv[1])' "$sqlite"

cp "$root/packages/release/bin/nudge-server" "$root/packages/release/bin/nudge" "$work/bin/"

# Tailscale's newest stable build, checked against the hash it publishes: a server downloading it
# itself can take many minutes, as from exe.dev, where pkgs.tailscale.com sends about 65 KB/s.
packages=https://pkgs.tailscale.com/stable
tailscale=$(curl -fsSL "$packages/?mode=json" |
  "$work/node/bin/node" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).Tarballs[process.argv[1]]))' "$tailscale_arch")
curl -fsSL "$packages/$tailscale" -o "$out/$tailscale"
echo "$(curl -fsSL "$packages/$tailscale.sha256")  $tailscale" | (cd "$out" && sha256sum -c -)
mkdir "$work/tailscale"
tar -xzf "$out/$tailscale" -C "$work/tailscale" --strip-components=1 --wildcards '*/tailscale' '*/tailscaled'
rm "$out/$tailscale"

# Wired's Node binding, from its release at the version and hashes wired.sh pins.
"$root/packages/release/scripts/wired.sh" "$work" "linux-$arch"
"$work/node/bin/node" -e 'if (typeof require(process.argv[1]).Node.anchor !== "function") process.exit(1)' \
  "$work/wired-node/index.js"

# Chromium, from Google's storage, can take hours to download on a server, as on exe.dev, where it
# comes at about 30 KB/s; from the release on GitHub, seconds.
if [ -n "${NUDGE_RELEASE_URL:-}" ]; then
  browsers=$out/browsers-$arch
  chromium=chromium-$version-linux-$arch.tar.gz
  rm -rf "$browsers" "$out/$chromium"
  PLAYWRIGHT_BROWSERS_PATH=$browsers \
    "$work/node/bin/node" "$work/app/node_modules/patchright/cli.js" install chromium
  tar -C "$browsers" -czf "$out/$chromium" --exclude=./.links .
  printf '{"url":"%s/%s","sha256":"%s"}\n' "${NUDGE_RELEASE_URL%/}" "$chromium" \
    "$(sha256sum "$out/$chromium" | cut -d' ' -f1)" >"$work/chromium.json"
  rm -rf "$browsers"
fi

echo "$version" >"$work/VERSION"
tar -C "$out" -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
echo "$out/$name.tar.gz"
