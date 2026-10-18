//! Speech to text on the device, with whisper.cpp: the audio never leaves it, since Nudge's
//! redaction only sees text. An app downloads one of the [`MODELS`] once, loads it as a
//! [`Transcriber`], and feeds a [`Session`] the microphone's samples; the session cuts them at
//! pauses, writes out each stretch in whichever of the player's languages it hears, and tells a
//! [`Listener`] the text so far.

mod download;
mod models;
mod session;
mod transcriber;

pub use download::{download, downloaded, model_path, open, remove};
pub use models::{MODELS, Model, model};
pub use session::{Engine, Listener, Session, Update};
pub use transcriber::{Transcriber, Transcript};

/// Samples a second: whisper hears 16 kHz mono.
pub const SAMPLE_RATE: usize = 16_000;

#[derive(Debug, thiserror::Error)]
pub enum SpeechError {
    #[error("no speech model {0}")]
    UnknownModel(String),
    #[error("couldn't download the speech model: {0}")]
    Download(String),
    #[error("the speech model didn't load: {0}")]
    Load(String),
    #[error("couldn't write out speech: {0}")]
    Transcribe(String),
}

/// Whisper's code for a player's language tag: `nb-NO` is Norwegian, `no`; `nn-NO` Nynorsk;
/// others by their language, `en-US` as `en`.
pub fn whisper_language(tag: &str) -> String {
    let language = tag
        .split(['-', '_'])
        .next()
        .unwrap_or(tag)
        .to_ascii_lowercase();
    match language.as_str() {
        "nb" => "no".into(),
        "cmn" | "yue" => "zh".into(),
        _ => language,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_map_to_whisper() {
        assert_eq!(whisper_language("nb-NO"), "no");
        assert_eq!(whisper_language("nn-NO"), "nn");
        assert_eq!(whisper_language("en-US"), "en");
        assert_eq!(whisper_language("en"), "en");
        assert_eq!(whisper_language("pt_BR"), "pt");
        assert_eq!(whisper_language("cmn-Hans-CN"), "zh");
    }
}
