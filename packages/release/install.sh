#!/bin/sh
# Installs a Nudge server on Linux (ADR 11), and starts it in setup mode:
#
#   curl -fsSL https://raw.githubusercontent.com/lum1n/nudge/main/packages/release/install.sh | sh
#
# As a user: into ~/.local/share/nudge, run by a systemd user service that starts at boot.
# As root: into /var/lib/nudge, run by a system service as the user nudge.
# Then open the setup link it prints. The server updates itself after that; this script is only
# for installing. The archive is checked against the sha256 the release's manifest gives (over
# HTTPS); the server checks every later release's signature itself.
set -eu

repo=${NUDGE_REPO:-lum1n/nudge}
manifest_url=${NUDGE_MANIFEST_URL:-https://github.com/$repo/releases/latest/download/manifest.json}
port=${NUDGE_PORT:-8787}

say() { printf '%s\n' "$*"; }
fail() {
  say "nudge install: $*" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "Nudge servers run on Linux"
case $(uname -m) in
  x86_64) platform=linux-x64 ;;
  aarch64 | arm64) platform=linux-arm64 ;;
  *) fail "No release for $(uname -m)" ;;
esac
for tool in curl tar sha256sum systemctl; do
  command -v "$tool" >/dev/null || fail "Needs $tool"
done

if [ "$(id -u)" = 0 ]; then
  home=${NUDGE_HOME:-/var/lib/nudge}
  bin=/usr/local/bin
  id nudge >/dev/null 2>&1 || useradd --system --home-dir "$home" --shell /usr/sbin/nologin nudge
else
  home=${NUDGE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/nudge}
  bin=$HOME/.local/bin
fi
releases=$home/releases
mkdir -p "$releases" "$bin"

say "Finding the newest release…"
manifest=$(curl -fsSL "$manifest_url")
# The manifest is written one field a line (sign.mjs); take this platform's block.
block=$(printf '%s\n' "$manifest" | sed -n "/\"$platform\"/,/}/p")
url=$(printf '%s\n' "$block" | sed -n 's/.*"url": *"\([^"]*\)".*/\1/p')
sha256=$(printf '%s\n' "$block" | sed -n 's/.*"sha256": *"\([^"]*\)".*/\1/p')
version=$(printf '%s\n' "$manifest" | sed -n 's/^  "version": *"\([^"]*\)".*/\1/p')
[ -n "$url" ] && [ -n "$sha256" ] && [ -n "$version" ] || fail "No $platform release in $manifest_url"

say "Downloading Nudge $version for $platform…"
archive=$releases/$version.tar.gz
curl -fsSL "$url" -o "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum -c --status - || {
  rm -f "$archive"
  fail "The download isn't the release: its sha256 differs"
}
rm -rf "$releases/$version.unpacking"
mkdir "$releases/$version.unpacking"
tar -xzf "$archive" -C "$releases/$version.unpacking" --strip-components=1
rm -rf "$releases/$version" "$archive"
mv "$releases/$version.unpacking" "$releases/$version"
ln -sfn "$version" "$releases/current"
ln -sfn "$releases/current/bin/nudge" "$bin/nudge"

command="$releases/current/bin/nudge-server --host 0.0.0.0 --port $port"
if [ "$(id -u)" = 0 ]; then
  chown -R nudge:nudge "$home"
  cat >/etc/systemd/system/nudge.service <<EOF
[Unit]
Description=Nudge
After=network-online.target
Wants=network-online.target

[Service]
User=nudge
Environment=NUDGE_HOME=$home
ExecStart=$command
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now nudge
  logs="journalctl -u nudge"
else
  units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  mkdir -p "$units"
  cat >"$units/nudge.service" <<EOF
[Unit]
Description=Nudge

[Service]
Environment=NUDGE_HOME=$home
ExecStart=$command
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  # So it runs without anyone signed in, and starts at boot.
  loginctl enable-linger "$(id -un)" 2>/dev/null || say "(Couldn't keep it running after you sign out: loginctl enable-linger $(id -un))"
  systemctl --user daemon-reload
  systemctl --user enable --now nudge
  logs="journalctl --user -u nudge"
fi

say "Starting…"
link=
for _ in $(seq 1 30); do
  link=$($logs -n 100 --no-pager -o cat 2>/dev/null | sed -n 's/^ *\(http[^ ]*\/setup#code=[^ ]*\).*/\1/p' | tail -1)
  [ -n "$link" ] && break
  sleep 1
done
say ""
if [ -n "$link" ]; then
  say "Nudge $version is running. Set it up in a browser:"
  say ""
  say "  $link"
  say ""
  say "(From another device, use this machine's address instead of the one in the link.)"
else
  say "Nudge $version is installed. Its setup link is in: $logs"
fi
say "The nudge command is in $bin."
