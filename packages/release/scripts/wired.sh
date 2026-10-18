#!/bin/sh
# Puts Wired's Node binding (github.com/lum1n/wired) in <dir>/wired-node, from its release, checked
# against the hashes pinned here: a new Wired comes in by changing these, not by whatever its latest
# release is. bundle.sh uses it for releases; in a checkout, `pnpm wired:fetch` puts it in
# .wired-node/, where the server finds it.
#   wired.sh [<dir>] [<platform>]   (default: the checkout's root, and this machine's platform)
set -eu

version=0.1.2
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
  linux-x64) sha256=236ee751f4ced501507986cd2f71a463fa1dad6923e0d3cc7471617107adfe89 ;;
  linux-arm64) sha256=d744f4503ca054157930b2a1262bc65e21e3ecfed035fd22b0aca52d3f8d7bda ;;
  darwin-arm64) sha256=6f29db9582657af664f9c00b356a3cb7ba60970e0fedc0623328dd564adc8577 ;;
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
