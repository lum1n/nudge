//! Pushes through a push relay come sealed for the device, so the relay, Apple and Google see
//! only ciphertext: AES-256-GCM under a key from X25519 between a key made for that push alone
//! and the device's, through HKDF-SHA256. `extensions/push/src/device-seal.ts` seals them; this
//! opens them on the device. A sealed push is one string, `v1.<epk>.<iv>.<data>.<tag>`, base64url.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

const INFO: &[u8] = b"nudge push v1";

/// A device's X25519 key pair, each half 32 bytes in base64url. The app keeps the private half
/// to itself and gives the public half to every server, which seals its pushes for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceKey {
    pub public_key: String,
    pub private_key: String,
}

impl DeviceKey {
    pub fn generate() -> Self {
        let secret = StaticSecret::from(rand::random::<[u8; 32]>());
        DeviceKey {
            public_key: URL_SAFE_NO_PAD.encode(PublicKey::from(&secret).as_bytes()),
            private_key: URL_SAFE_NO_PAD.encode(secret.to_bytes()),
        }
    }
}

/// What a push says, once opened: the same fields the server sends APNs and FCM directly.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPayload {
    pub assistant: String,
    pub room_id: String,
    /// `answer` or `approval`.
    pub kind: String,
    /// The room's page, from the site's root: `/<assistant>/<room>`.
    pub url: String,
    pub title: String,
    pub body: String,
    /// The same for every push of a room, so a newer one replaces the older.
    pub tag: String,
}

/// What `sealed` holds, if it was sealed for the device whose private key is `private_key`;
/// `None` for anything else, such as a push for another device or one changed on the way.
pub fn open_push(private_key: &str, sealed: &str) -> Option<PushPayload> {
    let mut parts = sealed.split('.');
    if parts.next()? != "v1" {
        return None;
    }
    let (epk, iv, data, tag) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let secret = StaticSecret::from(key32(private_key)?);
    let device_key = URL_SAFE_NO_PAD.encode(PublicKey::from(&secret).as_bytes());
    let shared = secret.diffie_hellman(&PublicKey::from(key32(epk)?));
    let salt = format!("{epk}.{device_key}");
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(salt.as_bytes()), shared.as_bytes())
        .expand(INFO, &mut key)
        .ok()?;
    let iv = URL_SAFE_NO_PAD.decode(iv).ok()?;
    if iv.len() != 12 {
        return None;
    }
    let mut message = URL_SAFE_NO_PAD.decode(data).ok()?;
    message.extend(URL_SAFE_NO_PAD.decode(tag).ok()?);
    let plain = Aes256Gcm::new_from_slice(&key)
        .ok()?
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &message,
                aad: salt.as_bytes(),
            },
        )
        .ok()?;
    serde_json::from_slice(&plain).ok()
}

fn key32(text: &str) -> Option<[u8; 32]> {
    URL_SAFE_NO_PAD.decode(text).ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sealed by `sealForDevice` in Node, so both sides agree on the format.
    const PRIVATE_KEY: &str = "2H0XZEmV28sOsF1EIR16Sd_pQABbg08gH5DlppstEX4";
    const PUBLIC_KEY: &str = "DpbmQpUrpldSy9QZJWP8TRW4ZSWv0oIl6n4dhDye3UA";
    const SEALED: &str = "v1.T0dSqd59KqvkxruSf5XfMaksrJMQSd6f4Y23MDEgRRI.XaEXikvjFmdkDhz3.azJ9_MXJ_2koa7h0RYefOFpthHqntq9X3UEwP5rUw_sPqDTKrbU9s1kcy7anOuJvT-BxNEcbTsHPIPhaVEOT1F7QR85E4bc6tTDvXzhLrmhc4M0IlGhe-025VhbNcjjbNkJqnjjuVMETG22P761mXA6Kr7pfWLn4Q1Uhf8RUCXhueHRv4gQswuGepdu7sBhc6ah9r2qRZKU.xHi6o9eipQASp41Y_YmC5w";

    #[test]
    fn opens_a_push_the_server_sealed() {
        let secret = StaticSecret::from(key32(PRIVATE_KEY).unwrap());
        assert_eq!(
            URL_SAFE_NO_PAD.encode(PublicKey::from(&secret).as_bytes()),
            PUBLIC_KEY
        );
        assert_eq!(
            open_push(PRIVATE_KEY, SEALED),
            Some(PushPayload {
                assistant: "robin".into(),
                room_id: "trip".into(),
                kind: "answer".into(),
                url: "/robin/trip".into(),
                title: "Robin · Trip".into(),
                body: "The train leaves at 09:12.".into(),
                tag: "robin/trip".into(),
            })
        );
    }

    #[test]
    fn opens_nothing_for_another_device_or_a_changed_push() {
        assert_eq!(open_push(&DeviceKey::generate().private_key, SEALED), None);
        let changed = SEALED.replacen("v1.T0d", "v1.T1d", 1);
        assert_eq!(open_push(PRIVATE_KEY, &changed), None);
        assert_eq!(open_push(PRIVATE_KEY, "v2.a.b.c.d"), None);
        assert_eq!(open_push(PRIVATE_KEY, "nonsense"), None);
    }

    #[test]
    fn makes_keys_that_fit_together() {
        let key = DeviceKey::generate();
        let secret = StaticSecret::from(key32(&key.private_key).unwrap());
        assert_eq!(
            URL_SAFE_NO_PAD.encode(PublicKey::from(&secret).as_bytes()),
            key.public_key
        );
        assert_eq!(key.public_key.len(), 43);
    }
}
