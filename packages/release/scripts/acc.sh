#!/bin/sh
# Puts ACC's Node binding (github.com/lum1n/acc) in <dir>/acc-node, from its release, checked
# against the hashes pinned here: a new ACC comes in by changing these, not by whatever its latest
# release is. With ACC_SRC set, it builds the binding from that ACC checkout with cargo instead.
# bundle.sh uses it for releases; in a checkout, `pnpm acc:fetch` puts it in .acc-node/, where the
# acc extension finds it.
#   acc.sh [<dir>] [<platform>]   (default: the checkout's root, and this machine's platform)
set -eu

version=0.2.0
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-$here/../../..}
platform=${2:-}
if [ -z "$platform" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) platform=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
    Darwin-arm64) platform=darwin-arm64 ;;
    *) echo "ACC has no build for $(uname -s) $(uname -m)" >&2 && exit 1 ;;
  esac
fi
case $dir in
  # A checkout: .acc-node/ (ignored by git). A release: acc-node/.
  "$here/../../..") target=$dir/.acc-node ;;
  *) target=$dir/acc-node ;;
esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/acc-node"

if [ -z "$version" ] || [ -n "${ACC_SRC:-}" ]; then
  src=${ACC_SRC:-$here/../../../../acc}
  [ -f "$src/crates/acc-node/Cargo.toml" ] ||
    { echo "No ACC release is pinned and there is no ACC checkout at $src (set ACC_SRC)" >&2 && exit 1; }
  node "$src/crates/acc-node/scripts/build.mjs" --release >&2
  node_platform=$(node -p 'process.platform + "-" + process.arch')
  [ "$node_platform" = "$platform" ] ||
    { echo "Building from a checkout makes $node_platform, not $platform" >&2 && exit 1; }
  cp "$src/crates/acc-node/index.js" "$src/crates/acc-node/index.d.ts" \
    "$src/crates/acc-node/package.json" "$src/crates/acc-node/acc.$platform.node" "$work/acc-node/"
  from="the checkout at $src"
else
  case $platform in
    linux-x64) sha256=739e1f95ae185178d659bb6517b7cb7c8b74c48dc8de0ca0a8bf395f69efd5e8 ;;
    linux-arm64) sha256=2b8b1a6af63c81b09551dfd6b55450f404d5040610a7a556f3f7b460fb296857 ;;
    darwin-arm64) sha256=ef1f0c79ede69a0e74e7b3a788c51b705b8adb5c739b984254c8ea86063b7298 ;;
    *) echo "ACC has no build for $platform" >&2 && exit 1 ;;
  esac
  archive=acc-node-$version-$platform.tar.gz
  curl -fsSL "https://github.com/lum1n/acc/releases/download/v$version/$archive" -o "$work/$archive"
  if command -v sha256sum >/dev/null; then
    echo "$sha256  $archive" | (cd "$work" && sha256sum -c -)
  else
    echo "$sha256  $archive" | (cd "$work" && shasum -a 256 -c -)
  fi
  rm -rf "$work/acc-node"
  tar -xzf "$work/$archive" -C "$work"
  from="release $version"
fi
rm -rf "$target"
mv "$work/acc-node" "$target"
echo "ACC from $from for $platform in $target"
