# Nudge for Android

The Kotlin client of [protocol v1](../../docs/protocol/v1.md): the Rust client (`../rust`) through its UniFFI bindings, as an Android library (`nudge`), and a small Compose app on it (`sample`).

- `nudge.ffi`: the generated bindings, written from the Rust library at build time. `NudgeClient(ClientConfig, TokenStore)` has the commands (`pair`, `me`, `send`, `abort`, `remember`, `decide`, …, and the admin ones, as suspend functions), `connect()`/`disconnect()` for the socket, and listeners for the views. Refusals throw `NudgeException.Status` (`status`, `detail`).
- `nudge.client`: `observeConnectionState()`, `observeHomeState()` and `observeRoomState(room)` give `Observed` objects with a `StateFlow` of the latest state, for view models and Compose; a `RoomState` has the whole timeline, rebuilt from the bindings' changes. `close()` them when done. `MemoryTokens` and `PreferencesTokens` keep the token.

```kotlin
val client = NudgeClient(
    ClientConfig(server, "robin", "my-app", "1.0", "android", File(filesDir, "nudge.sqlite").path),
    PreferencesTokens(getSharedPreferences("nudge", 0)),
)
client.connect()
client.pair(code)                      // once; the token is stored
val trip = client.observeRoomState("trip")
trip.state.collect { state -> /* state?.timeline, state?.pending, … */ }
client.send("trip", "When does the train leave?", null)
```

## Build

Needs the Android SDK (`local.properties` with `sdk.dir`, or `ANDROID_HOME`), JDK 17 for Gradle, and for the native libraries [cargo-ndk](https://github.com/bbqsrc/cargo-ndk) with the Rust targets `aarch64-linux-android`, `armv7-linux-androideabi` and `x86_64-linux-android` (`rustup target add …`).

```bash
./gradlew :sample:assembleDebug                         # bindings, native libraries, app
./gradlew :nudge:testDebugUnitTest -Pnudge.native=false # on this machine's JVM, no NDK needed
```

`-Pnudge.native=false` skips cargo-ndk; the build then has no native libraries and runs only on the JVM. The unit tests load the host build of `libnudge_ffi` and run against a server on a faux model (`node packages/server/scripts/faux-server.ts`, after `pnpm build` in the repository).
