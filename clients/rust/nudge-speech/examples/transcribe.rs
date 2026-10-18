//! Writes out a WAV file (16-bit, 16 kHz, mono) through a session, as if spoken into the
//! microphone, printing each update and how long it took:
//! `cargo run --release -p nudge-speech --example transcribe -- <model.bin> <file.wav> [no,en]`;
//! `DETECTOR=<model.bin>` tells the languages apart with another model.
use std::sync::Arc;
use std::time::Instant;

use nudge_speech::{Listener, SAMPLE_RATE, Session, Transcriber, Update};

struct Print(Instant);

impl Listener for Print {
    fn update(&self, update: Update) {
        let mark = if update.done { "done" } else { "    " };
        let language = update.language.as_deref().unwrap_or("?");
        println!(
            "{:6.1}s {mark} [{language}] {}",
            self.0.elapsed().as_secs_f32(),
            update.text
        );
        if let Some(problem) = update.problem {
            println!("problem: {problem}");
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [model, wav, rest @ ..] = args.as_slice() else {
        panic!("usage: transcribe <model.bin> <file.wav> [languages]");
    };
    let languages: Vec<String> = rest
        .first()
        .map(|list| list.split(',').map(str::to_owned).collect())
        .unwrap_or_default();
    let bytes = std::fs::read(wav).expect("the WAV file reads");
    // The samples follow the "data" chunk's header.
    let data = bytes
        .windows(4)
        .position(|w| w == b"data")
        .expect("a data chunk")
        + 8;
    let samples: Vec<f32> = bytes[data..]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| i16::from_le_bytes(*b) as f32 / 32768.0)
        .collect();

    let loading = Instant::now();
    let detector = std::env::var("DETECTOR").ok();
    let transcriber = Arc::new(
        Transcriber::load(
            model.as_ref(),
            detector.as_deref().map(std::path::Path::new),
        )
        .expect("the model loads"),
    );
    println!("loaded in {:.1}s", loading.elapsed().as_secs_f32());
    let started = Instant::now();
    let session = Session::start(transcriber, languages, Arc::new(Print(started)));
    // In real time, 100 ms at a time, as a microphone would.
    for (i, bit) in samples.chunks(SAMPLE_RATE / 10).enumerate() {
        session.push(bit);
        let due = started + std::time::Duration::from_millis(100 * (i as u64 + 1));
        std::thread::sleep(due.saturating_duration_since(Instant::now()));
    }
    session.finish();
    session.join();
}
