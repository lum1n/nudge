use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::transcriber::{Transcriber, Transcript};
use crate::{SAMPLE_RATE, SpeechError};

/// Writes out speech: a [`Transcriber`], or a stand-in in tests.
pub trait Engine: Send + Sync + 'static {
    fn transcribe(
        &self,
        samples: &[f32],
        languages: &[String],
        previous: Option<&str>,
    ) -> Result<Transcript, SpeechError>;
}

impl Engine for Transcriber {
    fn transcribe(
        &self,
        samples: &[f32],
        languages: &[String],
        previous: Option<&str>,
    ) -> Result<Transcript, SpeechError> {
        Transcriber::transcribe(self, samples, languages, previous)
    }
}

/// Hears a [`Session`], on the session's own thread.
pub trait Listener: Send + Sync + 'static {
    fn update(&self, update: Update);
}

#[derive(Clone, Debug, PartialEq)]
pub struct Update {
    /// Everything heard so far: what's settled, then a guess at what is still being said.
    pub text: String,
    /// Whisper's code of the language of the latest stretch.
    pub language: Option<String>,
    /// The last update: the session finished, or failed with `problem`.
    pub done: bool,
    pub problem: Option<String>,
}

/// Samples in a frame the session judges speech or quiet by: 30 ms.
const FRAME: usize = SAMPLE_RATE * 30 / 1000;
/// Quiet this long after speech ends a stretch.
const PAUSE: usize = SAMPLE_RATE * 6 / 10;
/// A stretch this long ends anyway; whisper hears 30 seconds at most.
const LONGEST: usize = SAMPLE_RATE * 25;
/// Kept from before speech starts, so its first sound isn't cut off; and after it ends.
const MARGIN: usize = SAMPLE_RATE * 3 / 10;
/// How often to guess at the stretch still being said, and the least speech worth a guess.
const GUESS_EVERY: Duration = Duration::from_millis(1200);
const GUESS_FROM: usize = SAMPLE_RATE;

/// One dictation: [`push`](Session::push) the microphone's samples, 16 kHz mono, as they come;
/// [`finish`](Session::finish) when the player stops. The listener hears the text after each
/// pause, a guess while they talk, and a last update with `done`.
pub struct Session {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

struct Shared {
    audio: Mutex<Audio>,
    wake: Condvar,
}

#[derive(Default)]
struct Audio {
    /// The stretch being said, with up to [`MARGIN`] of quiet before it.
    stretch: Vec<f32>,
    /// Whether `stretch` has speech yet, and the quiet at its end.
    speech: bool,
    quiet: usize,
    /// The level of the room's quiet, so speech is what stands out from it.
    floor: f32,
    /// Samples short of a whole frame.
    partial: Vec<f32>,
    /// Stretches that ended, waiting to be written out.
    ended: VecDeque<Vec<f32>>,
    /// Bumped when `stretch` grows, so a guess isn't made twice of the same audio.
    revision: u64,
    finished: bool,
    cancelled: bool,
}

impl Session {
    /// Starts a session writing out speech in `languages` (whisper codes, such as `no`, `en`;
    /// empty for any).
    pub fn start(
        engine: Arc<dyn Engine>,
        languages: Vec<String>,
        listener: Arc<dyn Listener>,
    ) -> Self {
        let shared = Arc::new(Shared {
            audio: Mutex::new(Audio {
                floor: 0.003,
                ..Audio::default()
            }),
            wake: Condvar::new(),
        });
        let worker = {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("nudge-speech".into())
                .spawn(move || work(&shared, engine.as_ref(), &languages, listener.as_ref()))
                .expect("a thread starts")
        };
        Self {
            shared,
            worker: Mutex::new(Some(worker)),
        }
    }

    /// Adds samples, 16 kHz mono, -1 to 1. Cheap: the writing out happens on the session's thread.
    pub fn push(&self, samples: &[f32]) {
        let mut audio = self.shared.audio.lock().unwrap();
        if audio.finished || audio.cancelled {
            return;
        }
        let mut samples = samples;
        if !audio.partial.is_empty() {
            let take = (FRAME - audio.partial.len()).min(samples.len());
            audio.partial.extend_from_slice(&samples[..take]);
            samples = &samples[take..];
            if audio.partial.len() == FRAME {
                let frame = std::mem::take(&mut audio.partial);
                audio.frame(&frame);
            }
        }
        let (frames, rest) = samples.as_chunks::<FRAME>();
        for frame in frames {
            audio.frame(frame);
        }
        audio.partial.extend_from_slice(rest);
        drop(audio);
        self.shared.wake.notify_one();
    }

    /// No more samples: the rest is written out, then the listener hears `done`.
    pub fn finish(&self) {
        self.shared.audio.lock().unwrap().finished = true;
        self.shared.wake.notify_one();
    }

    /// Stops at once; the listener hears nothing more.
    pub fn cancel(&self) {
        self.shared.audio.lock().unwrap().cancelled = true;
        self.shared.wake.notify_one();
    }

    /// Waits for the session's thread to end, after `finish` or `cancel`.
    pub fn join(&self) {
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.cancel();
    }
}

impl Audio {
    fn frame(&mut self, frame: &[f32]) {
        let level = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
        let speaking = level > (self.floor * 3.0).max(0.008);
        if !speaking {
            // The floor follows the room's quiet, slowly; speech doesn't move it.
            self.floor = self.floor * 0.95 + level * 0.05;
        }
        self.stretch.extend_from_slice(frame);
        self.revision += 1;
        if speaking {
            self.speech = true;
            self.quiet = 0;
        } else {
            self.quiet += frame.len();
        }
        if !self.speech {
            // Only the margin before speech is kept.
            let extra = self.stretch.len().saturating_sub(MARGIN);
            self.stretch.drain(..extra);
        } else if self.quiet >= PAUSE || self.stretch.len() >= LONGEST {
            self.end();
        }
    }

    /// Ends the stretch, if it had speech, keeping a margin of the quiet after it.
    fn end(&mut self) {
        if self.speech {
            let mut stretch = std::mem::take(&mut self.stretch);
            stretch.truncate(stretch.len() - self.quiet.saturating_sub(MARGIN).min(stretch.len()));
            self.ended.push_back(stretch);
        }
        self.stretch.clear();
        self.speech = false;
        self.quiet = 0;
    }
}

fn work(shared: &Shared, engine: &dyn Engine, languages: &[String], listener: &dyn Listener) {
    let mut settled: Vec<String> = Vec::new();
    let mut language: Option<String> = None;
    let mut guessed = (0u64, Instant::now() - GUESS_EVERY);
    let said = |settled: &[String], guess: Option<&str>| {
        let mut parts: Vec<&str> = settled.iter().map(String::as_str).collect();
        parts.extend(guess.filter(|g| !g.is_empty()));
        parts.join(" ")
    };

    loop {
        enum Job {
            Ended(Vec<f32>),
            Guess(Vec<f32>, u64),
            Last(Option<Vec<f32>>),
        }
        let job = {
            let mut audio = shared.audio.lock().unwrap();
            loop {
                if audio.cancelled {
                    return;
                }
                if let Some(stretch) = audio.ended.pop_front() {
                    break Job::Ended(stretch);
                }
                if audio.finished {
                    audio.end();
                    break Job::Last(audio.ended.pop_front());
                }
                let due = guessed.1.elapsed() >= GUESS_EVERY;
                if audio.speech
                    && audio.revision != guessed.0
                    && audio.stretch.len() >= GUESS_FROM
                    && due
                {
                    break Job::Guess(audio.stretch.clone(), audio.revision);
                }
                let wait = if audio.speech {
                    GUESS_EVERY.saturating_sub(guessed.1.elapsed())
                } else {
                    Duration::from_secs(1)
                };
                audio = shared
                    .wake
                    .wait_timeout(audio, wait.max(Duration::from_millis(20)))
                    .unwrap()
                    .0;
            }
        };

        let (samples, last) = match &job {
            Job::Ended(samples) => (Some(samples), false),
            Job::Guess(samples, revision) => {
                guessed = (*revision, Instant::now());
                (Some(samples), false)
            }
            Job::Last(samples) => (samples.as_ref(), true),
        };
        let mut problem = None;
        let mut guess = None;
        if let Some(samples) = samples {
            match engine.transcribe(samples, languages, language.as_deref()) {
                Ok(transcript) => {
                    language = transcript.language.or(language);
                    if matches!(job, Job::Guess(..)) {
                        guess = Some(transcript.text);
                    } else if !transcript.text.is_empty() {
                        settled.push(transcript.text);
                    }
                }
                Err(error) => problem = Some(error.to_string()),
            }
        }
        if shared.audio.lock().unwrap().cancelled {
            return;
        }
        let done = last || problem.is_some();
        listener.update(Update {
            text: said(&settled, guess.as_deref()),
            language: language.clone(),
            done,
            problem,
        });
        if done {
            shared.audio.lock().unwrap().cancelled = true;
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes out a stretch as its length in tenths of a second, so tests see where it was cut.
    struct Lengths;

    impl Engine for Lengths {
        fn transcribe(
            &self,
            samples: &[f32],
            languages: &[String],
            _: Option<&str>,
        ) -> Result<Transcript, SpeechError> {
            Ok(Transcript {
                text: format!(
                    "{}",
                    (samples.len() as f32 / SAMPLE_RATE as f32 * 10.0).round()
                ),
                language: languages.first().cloned(),
            })
        }
    }

    #[derive(Default)]
    struct Heard(Mutex<Vec<Update>>);

    impl Listener for Heard {
        fn update(&self, update: Update) {
            self.0.lock().unwrap().push(update);
        }
    }

    fn tone(seconds: f32) -> Vec<f32> {
        (0..(seconds * SAMPLE_RATE as f32) as usize)
            .map(|i| 0.2 * (i as f32 * 0.07).sin())
            .collect()
    }

    fn quiet(seconds: f32) -> Vec<f32> {
        vec![0.0005; (seconds * SAMPLE_RATE as f32) as usize]
    }

    fn run(audio: &[Vec<f32>]) -> Vec<Update> {
        let heard = Arc::new(Heard::default());
        let session = Session::start(Arc::new(Lengths), vec!["no".into()], heard.clone());
        for part in audio {
            // In bits of odd lengths, as a microphone hands them over.
            for bit in part.chunks(1234) {
                session.push(bit);
            }
        }
        session.finish();
        session.join();
        heard.0.lock().unwrap().clone()
    }

    #[test]
    fn cuts_at_pauses_and_keeps_margins() {
        let updates = run(&[quiet(1.0), tone(2.0), quiet(1.0), tone(1.5), quiet(0.2)]);
        let last = updates.last().unwrap();
        assert!(last.done);
        assert_eq!(last.problem, None);
        // 0.3 s before each stretch and 0.3 s after the first; the second ends with the input.
        assert_eq!(last.text, "26 20");
        assert_eq!(last.language.as_deref(), Some("no"));
    }

    #[test]
    fn quiet_alone_gives_no_text() {
        let updates = run(&[quiet(3.0)]);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].text, "");
        assert!(updates[0].done);
    }

    #[test]
    fn long_speech_is_cut_before_whisper_runs_out() {
        let updates = run(&[tone(31.0)]);
        let last = updates.last().unwrap();
        let parts: Vec<f32> = last.text.split(' ').map(|p| p.parse().unwrap()).collect();
        assert!(parts.iter().all(|&tenths| tenths <= 250.0), "{parts:?}");
        assert_eq!(parts.iter().sum::<f32>(), 310.0);
    }

    #[test]
    fn cancel_stops_without_a_last_update() {
        let heard = Arc::new(Heard::default());
        let session = Session::start(Arc::new(Lengths), vec![], heard.clone());
        session.push(&quiet(0.5));
        session.cancel();
        session.join();
        assert!(heard.0.lock().unwrap().is_empty());
    }
}
