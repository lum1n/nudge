#!/usr/bin/env bash
# Sets up the Nudge Xcode project on a Mac: checks for Xcode, XcodeGen and Rust, adds the Apple
# Rust targets that are missing, builds the Rust core as NudgeFFIC.xcframework, writes
# Nudge.xcodeproj from project.yml and opens it.
#
#   scripts/setup.sh                 everything, then open the project
#   scripts/setup.sh --project-only  only write the project again, such as after adding files
#   scripts/setup.sh --no-open       don't open Xcode at the end
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
client="$here/../../clients/apple"

rust=yes
open=yes
for arg in "$@"; do
  case "$arg" in
    --project-only) rust=no ;;
    --no-open) open=no ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option $arg; see $0 --help" >&2; exit 2 ;;
  esac
done

fail() { echo "$1" >&2; exit 1; }

[[ "$(uname)" == Darwin ]] || fail "This needs a Mac with Xcode; on Linux, clients/apple/scripts/build.sh builds the Swift package alone."
xcodebuild -version >/dev/null 2>&1 ||
  fail "No Xcode: install Xcode 26 from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app"
command -v xcodegen >/dev/null || fail "No XcodeGen: brew install xcodegen"
# 2.45.1 is the first to take the app icon from Icon Composer (Nudge/AppIcon.icon).
xcodegen_version="$(xcodegen --version | grep -Eo '[0-9]+(\.[0-9]+)+' | head -1)"
[[ "$(printf '%s\n' 2.45.1 "$xcodegen_version" | sort -V | head -1)" == 2.45.1 ]] ||
  fail "XcodeGen $xcodegen_version is too old for the app icon: brew upgrade xcodegen"

if [[ "$rust" == yes ]]; then
  command -v rustup >/dev/null || fail "No rustup: the Apple targets come from rustup (https://rustup.rs)"
  # The targets below go into rustup's toolchain; a cargo or rustc from elsewhere on the PATH,
  # such as Homebrew's, would build without them. So rustup's own go first.
  toolchain="$(dirname "$(rustup which rustc)")"
  if [[ "$(command -v rustc || true)" != "$toolchain/rustc" ]]; then
    echo "Using rustup's Rust ($toolchain) rather than $(command -v rustc || echo none)"
  fi
  export PATH="$toolchain:$PATH"
  targets=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin x86_64-apple-darwin)
  installed="$(rustup target list --installed)"
  missing=()
  for target in "${targets[@]}"; do
    grep -qx "$target" <<<"$installed" || missing+=("$target")
  done
  if ((${#missing[@]} > 0)); then
    echo "Adding Rust targets: ${missing[*]}"
    rustup target add "${missing[@]}"
  fi
  echo "Building the Rust core for iOS, the simulator and macOS…"
  "$client/scripts/build.sh" --xcframework
fi

[[ -d "$client/NudgeFFIC.xcframework" ]] ||
  fail "No NudgeFFIC.xcframework yet: run $0 without --project-only first."

cd "$here"
xcodegen generate --quiet
echo "Wrote $here/Nudge.xcodeproj. Pick your team under Signing & Capabilities (or set DEVELOPMENT_TEAM in project.yml), then build Nudge-iOS or Nudge-macOS."
[[ "$open" == yes ]] && open Nudge.xcodeproj
exit 0
