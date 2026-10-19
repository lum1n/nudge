#!/bin/sh
# Puts Wired's Node binding (github.com/lum1n/wired) in <dir>/wired-node, from its release, checked
# against the hashes pinned here: a new Wired comes in by changing these, not by whatever its latest
# release is. bundle.sh uses it for releases; in a checkout, `pnpm wired:fetch` puts it in
# .wired-node/, where the server finds it.
#   wired.sh [<dir>] [<platform>]   (default: the checkout's root, and this machine's platform)
set -eu

version=0.1.4
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
  linux-x64) sha256=0784cdc62d4b809c86dbdd3bb000b437c6cd6f6a0f516a366f9ca383a66a789c ;;
  linux-arm64) sha256=89dca5844aa5acfb176e625331177789987ab595d4b2e2f178d6a843262855d4 ;;
  darwin-arm64) sha256=070eecbf9f3a4199c71ad52f18edc4ee73d19d54d76db3c8419ccb235b40489f ;;
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
