use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{Model, SpeechError};

/// Where `model` is kept in `dir`, once downloaded.
pub fn model_path(dir: &Path, model: &Model) -> PathBuf {
    dir.join(format!("{}.bin", model.id))
}

/// Whether `model`, and its detector, are in `dir`.
pub fn downloaded(dir: &Path, model: &Model) -> bool {
    model
        .files()
        .iter()
        .all(|file| model_path(dir, file).exists())
}

/// Removes `model` from `dir`, and its detector unless `keep` (the models still wanted) needs it.
pub fn remove(dir: &Path, model: &Model, keep: &[&Model]) {
    for file in model.files() {
        let needed = keep
            .iter()
            .any(|kept| kept.id != model.id && kept.files().iter().any(|f| f.id == file.id));
        if !needed {
            let _ = std::fs::remove_file(model_path(dir, file));
            let _ = std::fs::remove_file(dir.join(format!("{}.part", file.id)));
        }
    }
}

/// Loads `model` from `dir`, with its detector.
pub fn open(dir: &Path, model: &Model) -> Result<crate::Transcriber, SpeechError> {
    let detector = model
        .detector
        .and_then(crate::model)
        .map(|detector| model_path(dir, detector));
    crate::Transcriber::load(&model_path(dir, model), detector.as_deref())
}

/// Downloads `model` into `dir`, telling `progress` the bytes so far and in all, and returns
/// its path. A download cut short goes on where it stopped the next time; one that doesn't match
/// the model's hash is thrown away.
pub async fn download(
    model: &Model,
    dir: &Path,
    progress: impl Fn(u64, u64) + Send,
) -> Result<PathBuf, SpeechError> {
    let path = model_path(dir, model);
    if path.exists() {
        progress(model.bytes, model.bytes);
        return Ok(path);
    }
    let failed = |error: &dyn std::fmt::Display| SpeechError::Download(error.to_string());
    std::fs::create_dir_all(dir).map_err(|e| failed(&e))?;
    let part = dir.join(format!("{}.part", model.id));

    // What an earlier try got, hashed again so the whole file is checked.
    let mut hash = Sha256::new();
    let mut have = 0u64;
    if let Ok(mut file) = std::fs::File::open(&part) {
        let mut buffer = vec![0; 1 << 20];
        loop {
            let read = file.read(&mut buffer).map_err(|e| failed(&e))?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
            have += read as u64;
        }
    }

    let client = reqwest::Client::new();
    let mut request = client.get(model.url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut response = request.send().await.map_err(|e| failed(&e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(SpeechError::Download(format!(
            "the server answered {status}"
        )));
    }
    let mut file = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        std::fs::OpenOptions::new().append(true).open(&part)
    } else {
        // The whole file again: the server doesn't do ranges, or there was nothing yet.
        hash = Sha256::new();
        have = 0;
        std::fs::File::create(&part)
    }
    .map_err(|e| failed(&e))?;
    progress(have, model.bytes);
    while let Some(chunk) = response.chunk().await.map_err(|e| failed(&e))? {
        file.write_all(&chunk).map_err(|e| failed(&e))?;
        hash.update(&chunk);
        have += chunk.len() as u64;
        progress(have, model.bytes);
    }
    file.flush().map_err(|e| failed(&e))?;
    drop(file);

    let sum: String = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if sum != model.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(SpeechError::Download(
            "the file isn't the model it should be".into(),
        ));
    }
    std::fs::rename(&part, &path).map_err(|e| failed(&e))?;
    Ok(path)
}
