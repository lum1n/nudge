# Nudge for Android

The Nudge app for Android 8 and later, in Jetpack Compose with Material 3 Expressive, on the library in [`clients/android`](../../clients/android) (the Rust core through UniFFI). Application id `app.nudge.dev`.

- The current Android design: Material 3 Expressive (`material3` 1.5, expressive motion, dynamic colour), the adaptive list-detail scaffold (rooms and the open room side by side on tablets and foldables, a room's lists and details in a third pane on wide screens, predictive back), flexible app bars, segmented lists as in Android's own Settings, the FAB menu for new rooms, and the shape-morphing loading indicator and buttons.
- Sign in with a pairing code (`nudge pair <player>` on the server) or by opening a `nudge://pair?…` link. The token stays in the app's private storage, out of backups.
- Rooms: a list on phones, beside the open room on tablets and wide screens. Each row shows when the assistant is answering and how many actions wait for approval.
- A `nudge://sign-in` link, from the QR code on the web UI's sign-in page, asks and then signs that browser in as you.
- Signed in at home, the app joins other assistants too: a `nudge://join` link from an admin there asks first, and the assistants joined from home on another device follow on their own. Their rooms are listed under each one's name. Settings shows your address, where you joined (take your own memory there or not, long press to leave) and your profile: picture, name, time zone, language, notifications and extensions' settings.
- A room: the timeline as it streams (text, thinking, tool calls), actions waiting for approval with Approve and Deny, fired nudges, messages on their way (with Retry and Dismiss when one fails), Stop, and earlier messages on demand. Views and unsent messages are cached, so the app opens offline and sends what waited once it's back.
- Privacy in shared rooms: the lock by the message field sends a message only you see, with its answer; others see that you sent one. Values someone else keeps to themselves show as *hidden*. Under Settings, "Only you see" hides an address, a name or a number in every room, and forgets one for good. A running tool shows what it is doing, such as the browser's `Clicking "Search"…`.
- Lists, documents (upload, download, delete, find by name) and connectors (API keys, typed and never shown again, the local network, read paths), over the extensions' panels, and the room's members, memory, nudges, extensions and what the model saw.
- The room's browser, live, from About this room or from "Open the room's browser to log in" when the assistant needs a login: tap to click, drag to scroll, type into the page, Take control from whoever has it, Done (and Remember, to save the login), and the saved logins.
- Settings: for admins, the assistant's extensions (on or off, their settings as a form drawn from each one's schema, and the rooms they are on in), your own memory and whether it's shared, this month's spend, notifications, sign out (which revokes the device's token on the server).
- Notifications through FCM when an answer is ready or an action waits for approval in a room you don't have open. The app disconnects in the background so the server knows to push. Tapping one opens the room.

## Build

Needs the Android SDK with platform 37, JDK 17 for Gradle (the wrapper is Gradle 9.8; AGP 9.4 and Kotlin 2.4), and for the native libraries [cargo-ndk](https://github.com/bbqsrc/cargo-ndk) with the Rust targets `aarch64-linux-android`, `armv7-linux-androideabi` and `x86_64-linux-android`. The library is an included build, so it is set up as in [its README](../../clients/android/README.md): `clients/android/local.properties` with `sdk.dir` (and `nudge.cargoHome`/`nudge.rustupHome` for a rustup of its own), and the same `sdk.dir` in `apps/android/local.properties`.

```bash
JAVA_HOME=/usr/lib/jvm/java-17-openjdk ./gradlew :app:installDebug   # bindings, native libraries, app
./gradlew :app:assembleDebug -Pnudge.native=false                     # without the native libraries: compiles, doesn't run
```

To try it without a real model: `pnpm build` in the repository, then `NUDGE_FAUX_PORT=8799 node packages/server/scripts/faux-server.ts`. It prints a pairing code for Bo; on the emulator the server is `http://10.0.2.2:8799`:

```bash
adb shell am start -a android.intent.action.VIEW -d '"nudge://pair?server=http%3A%2F%2F10.0.2.2%3A8799&assistant=robin&code=<code>"' app.nudge.dev
```

The faux server also has a second assistant, "team", that invited Ann from robin. Its addresses say `127.0.0.1`, so for joining, forward the port (`adb reverse tcp:8799 tcp:8799`), sign in as Ann at `http://127.0.0.1:8799`, and open the `team.link` it prints the same way.

## Push

Notifications need a Firebase project:

1. In the [Firebase console](https://console.firebase.google.com), add an Android app with the package name `app.nudge.dev` and download its `google-services.json` into `app/` (it is ignored by git). The build applies the Google services plugin only when the file is there; without it the app works without notifications.
2. Under Project settings → Service accounts, generate a private key, and give the JSON file to the server's push extension as `fcm.serviceAccountFile` (see the repository's README).

A server without that service account can still reach the app through a push relay (`packages/relay`) that has it. Build with `-Pnudge.pushRelay=https://relay.example`: when a server lists that relay in its push extension's `relays`, the app registers its FCM token with the relay and gives the server the relay's handle and a key of its own, made once and kept in the app's private storage. Those pushes arrive sealed for that key, and `PushService` opens them before it makes the notification.

## Releases

A release tag (`release.yml`) builds a signed APK, `nudge-<version>-android.apk`, with the version from the tag and the native libraries, when the repository has these secrets: `NUDGE_ANDROID_KEYSTORE` (the keystore, base64), `NUDGE_ANDROID_KEYSTORE_PASSWORD`, `NUDGE_ANDROID_KEY_ALIAS` and, when the key's password differs, `NUDGE_ANDROID_KEY_PASSWORD`. Make the keystore once and keep a copy somewhere safe: an update signed with another key won't install over the app.

```bash
keytool -genkeypair -keystore nudge-release.jks -alias nudge -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 nudge-release.jks   # the NUDGE_ANDROID_KEYSTORE secret
```

For notifications it also needs the project's `google-services.json` in the secret `NUDGE_GOOGLE_SERVICES_JSON`, and the push relay's address in the repository variable `NUDGE_PUSH_RELAY`, so servers without the project's Firebase account reach the app through the relay. Locally, the same build is `./gradlew :app:assembleRelease` with `NUDGE_KEYSTORE` (the keystore's path), `NUDGE_KEYSTORE_PASSWORD`, `NUDGE_KEY_ALIAS` and `NUDGE_KEY_PASSWORD` in the environment; without `NUDGE_KEYSTORE` it is unsigned.
