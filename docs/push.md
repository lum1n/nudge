# Notifications

Notifications come from the extension `extensions/push`, on each assistant that should send them:

```json
{
  "from": "./extensions/push",
  "settings": { "preview": "room", "subject": "mailto:you@example.com" }
}
```

"Turn on" under Notifications on the room list subscribes the browser to Web Push. Then answers, fired nudges and approvals in that player's rooms arrive as notifications, except for a room that is open in a visible tab. They need HTTPS, or `localhost`, and on an iPhone the site added to the home screen. Pushes are encrypted for the browser, so Google's, Mozilla's or Apple's push service only relays them. By default a notification says only which room has news; `"preview": "text"` adds the start of the text. The extension makes the server's push keys on first start, in `push-vapid.json` beside the database, shared by the assistants whose databases are there, since a browser has one subscription for the whole site; losing them means browsers must turn notifications on again. A room where someone turns the extension off with `/extensions` sends no pushes. When a browser renews its subscription by itself, the service worker hands the new one to the server without asking you.

The iOS, macOS and Android apps (`apps/apple`, `apps/android`) get the same notifications through APNs and FCM. The server sends them directly, so the extension needs credentials for them in its settings (paths absolute, or from the directory nudge runs in):

```json
"settings": {
  "apns": { "keyFile": "apns-key.p8", "keyId": "ABC123DEFG", "teamId": "XYZ987TEAM", "bundleId": "app.nudge.dev" },
  "fcm": { "serviceAccountFile": "firebase-service-account.json" }
}
```

The APNs key comes from the Apple Developer account (Keys, with Apple Push Notifications service); the FCM key is a service account of the Firebase project the Android app is built with (Project settings → Service accounts → Generate new private key). Without them the apps work, without notifications.

The published apps' APNs key and Firebase project are the project's, not yours, so a server reaches those apps through a push relay instead: list it in the extension's `"relays"`. An app registers its device with the relay and gets a handle, an encrypted form of its device token that only the relay can read. It gives each server it signs in to that handle and an X25519 key it made for itself. The server seals every push for that key (X25519, HKDF-SHA256, AES-256-GCM) and sends it to the relay with the handle. The relay opens the handle and passes the sealed push on, so the relay, Apple and Google see ciphertext and a hash of the room as the collapse id. The app decrypts it on the device: in a notification service extension on iOS and macOS, and as it arrives on Android. A relay keeps no list of devices and limits pushes per sender and per device.

`packages/relay` is the relay, run as `nudge-relay --config relay.json --port 8790` behind a TLS proxy:

```json
{
  "apns": {
    "keyFile": "AuthKey.p8",
    "keyId": "ABC123DEFG",
    "teamId": "XYZ987TEAM",
    "bundleId": "app.nudge"
  },
  "fcm": { "serviceAccountFile": "firebase-service-account.json" },
  "trustProxy": true
}
```

Paths are relative to `relay.json`. The relay makes `relay-handle.key` beside it on first start; losing it means every app registers again. Apps call `POST /v1/register { platform, token, environment? }` → `{ handle }`, and servers `POST /v1/send { handle, sealed, collapseId? }`: 204, 410 when the device is gone or the handle unknown, 429 past the limits (120 pushes a minute per sender, 30 per device, by default).
