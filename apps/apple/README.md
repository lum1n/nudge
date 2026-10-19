# Nudge for iPhone, iPad and Mac

The Nudge app for iOS 26 and macOS 26 (and later), in SwiftUI, on the Swift package in [`clients/apple`](../../clients/apple) (the Rust core through UniFFI). Bundle id `app.nudge.dev`.

- Sign in with a pairing code (`nudge pair <player>` on the server) or by opening a `nudge://pair?…` link. The token goes in the keychain.
- No server yet: "Make one on exe.dev" (signing in to exe.dev in the app: it asks for your email and mails a link that adds the app's own key to your account; key and token stay in the keychain) or "Set up one I started" runs the setup wizard (ADR 11): its address, the one-time setup code, the assistant's name, a model with your key or one running on the server, your name and nightly backups. The app signs in to the new assistant as your home and to the server as its owner; set up while signed in already, the new assistant is joined from home instead, you its admin and the server's owner. That needs federation at home, which the app checks first and can turn on.
- Settings → Servers, for the servers you own (the app signs in as owner of its home's server when you are one): each one's assistants (edit, delete, join from home, or new: for you, joined from home, or someone else's home with their pairing link), its model keys, automatic updates, the recovery kit, removing one made on exe.dev, and making another there.
- Rooms: a sidebar on the Mac and the iPad, a list on the iPhone. Each row shows when the assistant is answering and how many actions wait for approval.
- Signed in at home, the app joins other assistants too: a `nudge://join` link from an admin there asks first, and the assistants joined from home on another device follow on their own. Their rooms are listed under each one's name. Settings shows your address, where you joined (take your own memory there or not, leave from the context menu) and your profile: picture, name, time zone, language, notifications and extensions' settings.
- A room: the timeline as it streams (text, thinking, tool calls), approvals to approve or deny, fired nudges, messages on their way (with Retry and Dismiss when one fails), Stop, and earlier messages on demand. Views and unsent messages are cached, so the app opens offline and sends what waited once it's back.
- Dictation: the mic in the message field writes out what you say after what you typed, in whichever of your languages you speak (Norwegian and English to start with), switching between them from one sentence to the next. It runs whisper on the device, on the GPU, so your voice never leaves it; the first tap offers to download the speech model (NB-Whisper from the National Library of Norway, with OpenAI's base model to tell the languages apart: 235 MB). Settings → Speech picks another model (every language) and your languages.
- Privacy in shared rooms: the lock by the message field sends a message only you see, with its answer; others see that you sent one. Values someone else keeps to themselves show as *hidden*. Under Settings, "Only you see" hides an address, a name or a number in every room, and forgets one for good. A running tool shows what it is doing, such as the browser's `Clicking "Search"…`.
- Lists, documents (upload, download, delete, find by name) and connectors (API keys, typed and never shown again, the local network, read paths), over the extensions' panels, and the room's members, memory, nudges, extensions and what the model saw.
- The room's browser, live, from About this room or from "Open the room's browser to log in" when the assistant needs a login: tap to click, drag to scroll, type into the page, Take control from whoever has it, Done (and Remember, to save the login), and the saved logins.
- Settings: for admins, the assistant's extensions (on or off, their settings as a form drawn from each one's schema, and the rooms they are on in), your own memory and whether it's shared, this month's spend, notifications, sign out.
- Liquid Glass throughout: the timeline scrolls under a floating glass bar with the composer (Send morphs into Stop), actions waiting for approval and the live status; glass message bubbles (yours tinted), tool calls, nudges, markers and badges; glass buttons for approve/deny, retry, sign-in and load earlier. Toolbars, sidebars and sheets get the system's glass on their own.
- Notifications through APNs when an answer is ready or an action waits for approval in a room you don't have open. The app disconnects in the background so the server knows to push. Tapping one opens the room.

## Build

On a Mac with Xcode 26, [XcodeGen](https://github.com/yonaskolb/XcodeGen) 2.45.1 or later (`brew install xcodegen`), CMake (`brew install cmake`, for whisper.cpp) and Rust from [rustup](https://rustup.rs):

```bash
scripts/setup.sh
```

It adds the Apple Rust targets that are missing, builds the Rust core for iOS, the simulator and macOS (`clients/apple/scripts/build.sh --xcframework`), writes `Nudge.xcodeproj` from `project.yml` and opens it. Run it again after the Rust core changes; after adding files or changing `project.yml`, `scripts/setup.sh --project-only` only writes the project. `--no-open` leaves Xcode closed. Pick your team under Signing & Capabilities (or set `DEVELOPMENT_TEAM` in `project.yml`); the Nudge-iOS and Nudge-macOS schemes build the two apps.

To try it without a real model: `pnpm build` in the repository, then `node packages/server/scripts/faux-server.ts`. It prints the server's address and a pairing code for Bo; the simulator and the Mac reach it at that address.

## Push

The server sends to APNs itself, so it needs an APNs key: in the Apple Developer account, Keys → create a key with Apple Push Notifications service, download the `.p8`, and note its key id and your team id. Then in the settings of the server's push extension (see the repository's README):

```json
"apns": { "keyFile": "apns-key.p8", "keyId": "ABC123DEFG", "teamId": "XYZ987TEAM", "bundleId": "app.nudge.dev" }
```

A server without the key can still reach the app through a push relay (`packages/relay`) that has it. Set `NUDGE_PUSH_RELAY` in project.yml to the relay's address: when a server lists that relay in its push extension's `relays`, the app registers its APNs token with the relay and gives the server the relay's handle and a key of its own, kept in a keychain group it shares with its notification service extension (`NotificationService/`). Those pushes arrive as "New message" with the real one sealed for that key, and the extension opens it before it is shown. Both need the keychain group, so set a team.

Builds run from Xcode register as `sandbox` devices and get their pushes through Apple's sandbox; release builds through production. One key serves both. The simulator gets no pushes from APNs.
