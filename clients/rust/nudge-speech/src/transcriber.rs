use std::path::Path;
use std::sync::{Mutex, Once};

use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use crate::SpeechError;

/// A loaded model, which writes out stretches of speech up to 30 seconds long. One at a time:
/// a second caller waits for the first.
pub struct Transcriber {
    state: Mutex<WhisperState>,
    /// A model of its own to tell the languages apart, where the one writing out doesn't do it
    /// well: NB-Whisper hears Norwegian in English, and its `en` turns Norwegian into English.
    detector: Option<Mutex<WhisperState>>,
    threads: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Transcript {
    pub text: String,
    /// Whisper's code of the language it heard, such as `no` or `en`.
    pub language: Option<String>,
}

/// A stretch whisper is this sure has no speech in it gives no text: it makes words up there.
const NO_SPEECH: f32 = 0.6;

impl Transcriber {
    /// Loads the model at `path`, and the one at `detector` to tell languages apart with, on
    /// the GPU where there is one (Metal on Apple's).
    pub fn load(path: &Path, detector: Option<&Path>) -> Result<Self, SpeechError> {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().clamp(1, 6))
            .unwrap_or(4);
        Ok(Self {
            state: Mutex::new(state(path)?),
            detector: detector.map(state).transpose()?.map(Mutex::new),
            threads,
        })
    }

    /// Writes out `samples` (16 kHz mono) in whichever of `languages` (whisper codes) it hears
    /// most likely, leaning to `previous`, the language of the stretch before; in any language
    /// whisper knows when `languages` is empty.
    pub fn transcribe(
        &self,
        samples: &[f32],
        languages: &[String],
        previous: Option<&str>,
    ) -> Result<Transcript, SpeechError> {
        let failed = |e: whisper_rs::WhisperError| SpeechError::Transcribe(e.to_string());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let language = match languages {
            [] => None,
            [only] => Some(only.clone()),
            several => Some(
                match &self.detector {
                    Some(detector) => {
                        let mut detector = detector
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        self.detect(&mut detector, samples, several, previous)
                    }
                    None => self.detect(&mut state, samples, several, previous),
                }
                .map_err(failed)?,
            ),
        };

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(self.threads as i32);
        params.set_language(Some(language.as_deref().unwrap_or("auto")));
        params.set_translate(false);
        params.set_no_context(true);
        params.set_single_segment(samples.len() <= 30 * crate::SAMPLE_RATE);
        params.set_no_timestamps(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state.full(params, samples).map_err(failed)?;

        let mut text = String::new();
        for segment in state.as_iter() {
            // whisper.cpp leaves it at infinity on some segments with speech: no reading then.
            let no_speech = segment.no_speech_probability();
            if no_speech.is_finite() && no_speech > NO_SPEECH {
                continue;
            }
            let words = segment.to_str_lossy().map_err(failed)?;
            text.push_str(&words);
        }
        let heard = language.or_else(|| {
            whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(str::to_owned)
        });
        Ok(Transcript {
            text: tidy(&text),
            language: heard,
        })
    }

    /// The most likely of `languages` in `samples`, leaning to `previous`.
    fn detect(
        &self,
        state: &mut WhisperState,
        samples: &[f32],
        languages: &[String],
        previous: Option<&str>,
    ) -> Result<String, whisper_rs::WhisperError> {
        state.pcm_to_mel(samples, self.threads)?;
        let (_, odds) = state.lang_detect(0, self.threads)?;
        Ok(choose(languages, previous, |language| {
            whisper_rs::get_lang_id(language)
                .and_then(|id| odds.get(id as usize).copied())
                .unwrap_or(0.0)
        }))
    }
}

/// Languages whisper confuses with each other: Norwegian is heard as Swedish or Danish too.
const RELATIVES: &[&[&str]] = &[
    &["no", "nn", "sv", "da"],
    &["es", "gl", "ca", "pt"],
    &["nl", "af"],
    &["ru", "uk", "be"],
    &["hr", "sr", "bs"],
];

/// The language of a stretch before is this many times likelier, so a short stretch doesn't
/// switch on a whim.
const STAY: f32 = 2.0;

/// Which of `languages` has the most of `odds`, counting the relatives of each that aren't among
/// `languages` (one heard as Swedish is Norwegian, to a Norwegian), and leaning to `previous`.
fn choose(languages: &[String], previous: Option<&str>, odds: impl Fn(&str) -> f32) -> String {
    let score = |language: &str| {
        let relatives = RELATIVES.iter().find(|family| family.contains(&language));
        let others = relatives
            .into_iter()
            .flat_map(|family| family.iter())
            .filter(|relative| **relative != language && !languages.iter().any(|l| l == *relative));
        let total = odds(language) + others.map(|relative| odds(relative)).sum::<f32>();
        if previous == Some(language) {
            total * STAY
        } else {
            total
        }
    };
    languages
        .iter()
        .map(|language| (language, score(language)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map_or_else(String::new, |(language, _)| language.clone())
}

fn state(path: &Path) -> Result<WhisperState, SpeechError> {
    // whisper.cpp prints to stderr otherwise; without a log backend this quiets it.
    static QUIET: Once = Once::new();
    QUIET.call_once(whisper_rs::install_logging_hooks);
    let mut parameters = WhisperContextParameters::default();
    parameters.use_gpu(true).flash_attn(true);
    let context = WhisperContext::new_with_params(path, parameters)
        .map_err(|e| SpeechError::Load(e.to_string()))?;
    context
        .create_state()
        .map_err(|e| SpeechError::Load(e.to_string()))
}

/// The words without whisper's notes on sounds, `[MUSIC]` or `(latter)`, and extra spaces.
fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    // The character that ends the note being skipped.
    let mut until = None;
    for c in text.chars() {
        match (until, c) {
            (Some(end), c) if c == end => until = None,
            (Some(_), _) => {}
            (None, '[') => until = Some(']'),
            (None, '(') => until = Some(')'),
            (None, '*') => until = Some('*'),
            (None, c) => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::{choose, tidy};

    fn odds<'a>(table: &'a [(&'a str, f32)]) -> impl Fn(&str) -> f32 + 'a {
        |language| {
            table
                .iter()
                .find(|(l, _)| *l == language)
                .map_or(0.0, |(_, p)| *p)
        }
    }

    #[test]
    fn norwegian_heard_as_swedish_is_norwegian() {
        let languages = ["no".to_string(), "en".to_string()];
        let table = [("no", 0.109), ("en", 0.007), ("sv", 0.617), ("nn", 0.052)];
        assert_eq!(choose(&languages, None, odds(&table)), "no");
        // Unless Swedish is one of the player's languages.
        let with_swedish = ["no".to_string(), "sv".to_string()];
        assert_eq!(choose(&with_swedish, None, odds(&table)), "sv");
    }

    #[test]
    fn a_close_call_stays_with_the_language_before() {
        let languages = ["no".to_string(), "en".to_string()];
        // Norwegian and its relatives, 0.022, against English, 0.025.
        let table = [("no", 0.010), ("en", 0.025), ("nn", 0.008), ("sv", 0.004)];
        assert_eq!(choose(&languages, None, odds(&table)), "en");
        assert_eq!(choose(&languages, Some("no"), odds(&table)), "no");
        let table = [("no", 0.010), ("en", 0.030)];
        assert_eq!(choose(&languages, None, odds(&table)), "en");
        assert_eq!(choose(&languages, Some("no"), odds(&table)), "en");
        let table = [("no", 0.016), ("en", 0.030)];
        assert_eq!(choose(&languages, Some("no"), odds(&table)), "no");
        // English, clearly, wins.
        let table = [("no", 0.002), ("en", 0.478)];
        assert_eq!(choose(&languages, Some("no"), odds(&table)), "en");
    }

    #[test]
    fn tidy_drops_notes_on_sounds() {
        assert_eq!(
            tidy(" Hei, alle sammen. [MUSIKK]  Takk."),
            "Hei, alle sammen. Takk."
        );
        assert_eq!(tidy("(latter) Ja *applaus* nei"), "Ja nei");
        assert_eq!(tidy("  plain words "), "plain words");
    }
}
