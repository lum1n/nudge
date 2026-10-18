/// A whisper model an app can download, in whisper.cpp's format, quantized.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Model {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    /// SHA-256 of the file, in hex; a download that doesn't match is thrown away.
    pub sha256: &'static str,
    /// Whisper codes of the languages it writes out; empty for all of whisper's (about 100).
    pub languages: &'static [&'static str],
    /// The model that tells its languages apart, downloaded with it, where it can't do that well.
    pub detector: Option<&'static str>,
}

/// The models on offer, the one to start with first.
///
/// NB-Whisper is the National Library of Norway's whisper, trained further on Norwegian (Bokmål
/// and Nynorsk) and English. It writes Norwegian far better than OpenAI's, but can't tell the
/// languages apart: it hears Norwegian in English, and told `en` it translates Norwegian into
/// English. So OpenAI's base model picks the language of each stretch for it.
pub const MODELS: &[Model] = &[
    Model {
        id: "nb-whisper-small",
        name: "Norwegian and English",
        description: "NB-Whisper, from the National Library of Norway",
        url: "https://huggingface.co/NbAiLab/nb-whisper-small/resolve/main/ggml-model-q5_0.bin",
        bytes: 175_209_680,
        sha256: "2a9025afb6e825fc4ae6a46671e0cb2f43e62f1dec87270deea6fe61b5285a20",
        languages: &["no", "nn", "en"],
        detector: Some("whisper-base"),
    },
    Model {
        id: "whisper-small",
        name: "Every language",
        description: "OpenAI's whisper, small",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
        bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        languages: &[],
        detector: None,
    },
    Model {
        id: "whisper-base",
        name: "Every language, smaller",
        description: "OpenAI's whisper, base: quicker, and less accurate",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
        bytes: 59_707_625,
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
        languages: &[],
        detector: None,
    },
];

pub fn model(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|model| model.id == id)
}

impl Model {
    /// Whether it writes out `language`, a whisper code such as `no`.
    pub fn speaks(&self, language: &str) -> bool {
        self.languages.is_empty() || self.languages.contains(&language)
    }

    /// Whisper codes for the player's language tags (`nb-NO`, `en-US`) that it writes out, in
    /// their order; its own languages where it writes out none of theirs.
    pub fn languages_for(&self, tags: &[String]) -> Vec<String> {
        let mut languages: Vec<String> = Vec::new();
        for language in tags.iter().map(|tag| crate::whisper_language(tag)) {
            if self.speaks(&language) && !languages.contains(&language) {
                languages.push(language);
            }
        }
        if languages.is_empty() {
            languages = self.languages.iter().map(|l| l.to_string()).collect();
        }
        languages
    }

    /// This model and its detector: what to download, in order.
    pub fn files(&self) -> Vec<&'static Model> {
        let this = model(self.id).expect("a model in MODELS");
        std::iter::once(this)
            .chain(self.detector.and_then(model))
            .collect()
    }

    /// The bytes to download for it, its detector's too.
    pub fn download_bytes(&self) -> u64 {
        self.files().iter().map(|file| file.bytes).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detectors_are_models_that_detect_alone() {
        for model in MODELS {
            if let Some(detector) = model.detector {
                let detector = super::model(detector).expect("the detector is listed");
                assert!(detector.detector.is_none());
                assert!(detector.languages.is_empty());
            }
        }
        assert_eq!(
            model("nb-whisper-small").unwrap().download_bytes(),
            175_209_680 + 59_707_625
        );
    }

    #[test]
    fn languages_are_the_players_it_speaks() {
        let tags = |list: &[&str]| list.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        let norwegian = model("nb-whisper-small").unwrap();
        assert_eq!(
            norwegian.languages_for(&tags(&["nb-NO", "en-US", "en-GB", "de-DE"])),
            ["no", "en"]
        );
        assert_eq!(
            norwegian.languages_for(&tags(&["de-DE"])),
            ["no", "nn", "en"]
        );
        let every = model("whisper-small").unwrap();
        assert_eq!(
            every.languages_for(&tags(&["de-DE", "en-US"])),
            ["de", "en"]
        );
    }
}
