#!/usr/bin/env bash
# Writes the Swift bindings of nudge-ffi into Sources/, from a host build of the library.
# With --xcframework (macOS with Xcode and the Apple Rust targets), also builds
# NudgeFFIC.xcframework: iOS (arm64), the iOS simulator (arm64, x86_64), macOS (arm64, x86_64).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
rust="$here/../rust"
cd "$rust"

# With speech to text on the device (whisper.cpp); on Apple's GPUs, through Metal, in the apps.
cargo build -p nudge-ffi --features speech
case "$(uname)" in
  Darwin) host="target/debug/libnudge_ffi.dylib" ;;
  *) host="target/debug/libnudge_ffi.so" ;;
esac
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cargo run -q -p nudge-ffi --features cli --bin uniffi-bindgen -- \
  generate --no-format --library "$host" --language swift --out-dir "$out"

# Everything in these is generated and ignored, so a fresh clone has neither.
mkdir -p "$here/Sources/NudgeFFI" "$here/Sources/NudgeFFIC"
cp "$out/NudgeFFI.swift" "$here/Sources/NudgeFFI/NudgeFFI.swift"
cp "$out/NudgeFFIC.h" "$here/Sources/NudgeFFIC/NudgeFFIC.h"
# For Linux: the same module, linking the shared library.
cat > "$here/Sources/NudgeFFIC/module.modulemap" <<MODULE
module NudgeFFIC {
    header "NudgeFFIC.h"
    link "nudge_ffi"
    export *
}
MODULE

[[ "${1:-}" == "--xcframework" ]] || exit 0

targets=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin x86_64-apple-darwin)
# Match apps/apple/project.yml, so rustc and the C in crates like aws-lc-sys build for the same
# OS versions; otherwise rustc links for iOS 10 and misses symbols the C expects.
export IPHONEOS_DEPLOYMENT_TARGET=26.0 MACOSX_DEPLOYMENT_TARGET=26.0
# whisper.cpp: built for the target's CPU, not this Mac's (the x86_64 slices are built on arm64),
# and with the bindings whisper-rs-sys ships, the same for every 64-bit Apple target, rather than
# generated with a libclang Xcode doesn't put where bindgen looks.
export GGML_NATIVE=OFF WHISPER_DONT_GENERATE_BINDINGS=1
for target in "${targets[@]}"; do
  cargo build --release -p nudge-ffi --features metal --target "$target"
done
lib() { echo "target/$1/release/libnudge_ffi.a"; }
mkdir -p "$out/sim" "$out/macos" "$out/headers"
lipo -create "$(lib aarch64-apple-ios-sim)" "$(lib x86_64-apple-ios)" -output "$out/sim/libnudge_ffi.a"
lipo -create "$(lib aarch64-apple-darwin)" "$(lib x86_64-apple-darwin)" -output "$out/macos/libnudge_ffi.a"
cp "$out/NudgeFFIC.h" "$out/headers/"
cat > "$out/headers/module.modulemap" <<MODULE
module NudgeFFIC {
    header "NudgeFFIC.h"
    export *
}
MODULE
rm -rf "$here/NudgeFFIC.xcframework"
xcodebuild -create-xcframework \
  -library "$(lib aarch64-apple-ios)" -headers "$out/headers" \
  -library "$out/sim/libnudge_ffi.a" -headers "$out/headers" \
  -library "$out/macos/libnudge_ffi.a" -headers "$out/headers" \
  -output "$here/NudgeFFIC.xcframework"
