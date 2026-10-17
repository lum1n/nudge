#!/bin/sh
# Builds a Nudge server release for this machine's architecture (ADR 11):
#
#   dist/release/nudge-<version>-linux-<arch>.tar.gz
#     node/       Node, the release's own
#     app/        @nudge/release deployed with its production dependencies
#     bin/        nudge-server (the launcher) and nudge
#     VERSION
#
# Run on each architecture (x64, arm64): the SQLite module is native, built for the bundled Node.
#   packages/release/scripts/bundle.sh 0.1.0
set -eu

version=${1:?usage: bundle.sh <version>}
node_version=${NODE_VERSION:-24.22.0}
root=$(cd "$(dirname "$0")/../../.." && pwd)
case $(uname -m) in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
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
find "$work/app/node_modules" -type d \( -name test -o -name tests -o -name __tests__ \) -prune \
  -exec rm -rf {} +
"$work/node/bin/node" -e 'require(process.argv[1])' "$sqlite"

cp "$root/packages/release/bin/nudge-server" "$root/packages/release/bin/nudge" "$work/bin/"
echo "$version" >"$work/VERSION"
tar -C "$out" -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
echo "$out/$name.tar.gz"
