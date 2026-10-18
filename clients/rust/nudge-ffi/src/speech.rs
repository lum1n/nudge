//! Speech to text on the device (`nudge-speech`), for the apps' composers: download a model
//! once, load it as a `SpeechTranscriber`, and push the microphone's samples into a
//! `SpeechSession`. The audio stays on the device.

use std::path::PathBuf;
use std::sync::Arc;

use nudge_speech as speech;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum SpeechError {
    #[error("{detail}")]
    Failed { detail: String },
}

impl From<speech::SpeechError> for SpeechError {
    fn from(error: speech::SpeechError) -> Self {
        SpeechError::Failed {
            detail: error.to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SpeechModel {
    pub id: String,
    pub name: String,
    pub description: String,
    /// What it downloads, with the model that tells its languages apart.
    pub bytes: u64,
    /// Whisper codes of the languages it writes out (`no`, `nn`, `en`); empty for all.
    pub languages: Vec<String>,
}

/// The models on offer, the one to start with first.
#[uniffi::export]
pub fn speech_models() -> Vec<SpeechModel> {
    speech::MODELS
        .iter()
        .map(|model| SpeechModel {
            id: model.id.into(),
            name: model.name.into(),
            description: model.description.into(),
            bytes: model.download_bytes(),
            languages: model.languages.iter().map(|l| l.to_string()).collect(),
        })
        .collect()
}

fn model(id: &str) -> Result<&'static speech::Model, SpeechError> {
    speech::model(id).ok_or_else(|| speech::SpeechError::UnknownModel(id.into()).into())
}

/// Whether the model `id` is downloaded into `dir`.
#[uniffi::export]
pub fn speech_model_downloaded(dir: String, id: String) -> bool {
    speech::model(&id).is_some_and(|model| speech::downloaded(dir.as_ref(), model))
}

/// Removes the model `id` from `dir`, but not files `keep` (other models' ids) still use.
#[uniffi::export]
pub fn remove_speech_model(dir: String, id: String, keep: Vec<String>) {
    if let Some(model) = speech::model(&id) {
        let keep: Vec<_> = keep.iter().filter_map(|id| speech::model(id)).collect();
        speech::remove(dir.as_ref(), model, &keep);
    }
}

/// Hears a download, on one of the library's threads.
#[uniffi::export(with_foreign)]
pub trait SpeechDownloadListener: Send + Sync {
    fn on_progress(&self, done: u64, total: u64);
}

/// Downloads the model `id` into `dir`, with the model that tells its languages apart; one cut
/// short goes on where it stopped.
#[uniffi::export]
pub async fn download_speech_model(
    dir: String,
    id: String,
    listener: Arc<dyn SpeechDownloadListener>,
) -> Result<(), SpeechError> {
    let model = model(&id)?;
    crate::run(async move {
        let dir = PathBuf::from(dir);
        let total = model.download_bytes();
        let mut before = 0;
        for file in model.files() {
            let listener = listener.clone();
            speech::download(file, &dir, move |done, _| {
                listener.on_progress(before + done, total)
            })
            .await?;
            before += file.bytes;
        }
        Ok(())
    })
    .await
}

/// A loaded model. Loading takes a moment and memory (a few hundred MB); keep one while the
/// composer is on screen.
#[derive(uniffi::Object)]
pub struct SpeechTranscriber {
    model: &'static speech::Model,
    transcriber: Arc<speech::Transcriber>,
}

#[uniffi::export]
impl SpeechTranscriber {
    /// Loads the model `id` from `dir`; blocks, so not on the UI thread.
    #[uniffi::constructor]
    pub fn new(dir: String, id: String) -> Result<Arc<Self>, SpeechError> {
        let model = model(&id)?;
        let transcriber = speech::open(dir.as_ref(), model)?;
        Ok(Arc::new(Self {
            model,
            transcriber: Arc::new(transcriber),
        }))
    }

    /// Starts a dictation in the player's `languages` (tags such as `nb-NO`, `en-US`), as many
    /// of them as the model writes out.
    pub fn start(
        &self,
        languages: Vec<String>,
        listener: Arc<dyn SpeechListener>,
    ) -> Arc<SpeechSession> {
        let languages = self.model.languages_for(&languages);
        let session = speech::Session::start(
            self.transcriber.clone(),
            languages,
            Arc::new(ForeignListener(listener)),
        );
        Arc::new(SpeechSession { session })
    }
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SpeechUpdate {
    /// Everything heard so far; its end may still change while the player talks.
    pub text: String,
    /// The language of the latest stretch, as a tag: `nb`, `nn`, `en`.
    pub language: Option<String>,
    /// The last update: the dictation finished, or failed with `problem`.
    pub done: bool,
    pub problem: Option<String>,
}

/// Hears a dictation, on a thread of its own.
#[uniffi::export(with_foreign)]
pub trait SpeechListener: Send + Sync {
    fn on_update(&self, update: SpeechUpdate);
}

struct ForeignListener(Arc<dyn SpeechListener>);

impl speech::Listener for ForeignListener {
    fn update(&self, update: speech::Update) {
        self.0.on_update(SpeechUpdate {
            text: update.text,
            // Whisper's `no` is Bokmål to the apps.
            language: update
                .language
                .map(|l| if l == "no" { "nb".into() } else { l }),
            done: update.done,
            problem: update.problem,
        });
    }
}

/// A dictation: push the microphone's samples (16 kHz mono, -1 to 1) as they come, and finish
/// when the player stops; the listener hears the text after each pause and a guess while they
/// talk. Dropping it cancels it.
#[derive(uniffi::Object)]
pub struct SpeechSession {
    session: speech::Session,
}

#[uniffi::export]
impl SpeechSession {
    pub fn push(&self, samples: Vec<f32>) {
        self.session.push(&samples);
    }

    /// The rest is written out, then the listener hears `done`.
    pub fn finish(&self) {
        self.session.finish();
    }

    /// Stops at once; the listener hears nothing more.
    pub fn cancel(&self) {
        self.session.cancel();
    }
}
