//! Writes the Swift, Kotlin and Python bindings: `cargo run -p nudge-ffi --features cli --bin
//! uniffi-bindgen -- generate --library target/debug/libnudge_ffi.so --language python --out-dir out`.
fn main() {
    uniffi::uniffi_bindgen_main()
}
