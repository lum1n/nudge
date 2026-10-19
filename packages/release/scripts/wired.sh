#!/bin/sh
# Puts Wired's Node binding (github.com/lum1n/wired) in <dir>/wired-node, from its release, checked
# against the hashes pinned here: a new Wired comes in by changing these, not by whatever its latest
# release is. bundle.sh uses it for releases; in a checkout, `pnpm wired:fetch` puts it in
# .wired-node/, where the server finds it.
#   wired.sh [<dir>] [<platform>]   (default: the checkout's root, and this machine's platform)
set -eu

version=0.1.3
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-$here/../../..}
platform=${2:-}
if [ -z "$platform" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) platform=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
    Darwin-arm64) platform=darwin-arm64 ;;
    *) echo "Wired has no build for $(uname -s) $(uname -m)" >&2 && exit 1 ;;
  esac
fi
case $platform in
  linux-x64) sha256=a4c8e8a70123954c4dc438b01430f5848d8a45ac5b37218aad35f982781c05e9 ;;
  linux-arm64) sha256=07cb81072f0e13d50b2de85ceb328a12347706c18be1a02c64926eec685c8c67 ;;
  darwin-arm64) sha256=40504aa6706c0946be76ef0caeb1199ac2c2f987f09ea1a2b5997433e4cd5644 ;;
  *) echo "Wired has no build for $platform" >&2 && exit 1 ;;
esac

archive=wired-node-$version-$platform.tar.gz
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL "https://github.com/lum1n/wired/releases/download/v$version/$archive" -o "$work/$archive"
if command -v sha256sum >/dev/null; then
  echo "$sha256  $archive" | (cd "$work" && sha256sum -c -)
else
  echo "$sha256  $archive" | (cd "$work" && shasum -a 256 -c -)
fi
tar -xzf "$work/$archive" -C "$work"
case $dir in
  # A checkout: .wired-node/ (ignored by git). A release: wired-node/.
  "$here/../../..") target=$dir/.wired-node ;;
  *) target=$dir/wired-node ;;
esac
rm -rf "$target"
mv "$work/wired-node" "$target"
echo "Wired $version for $platform in $target"
