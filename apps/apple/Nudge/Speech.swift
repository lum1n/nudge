// Speech to text for the composer, written out on this device by whisper: the audio never
// leaves it, since Nudge's redaction only sees text. The models are downloaded once, into
// Application Support (not backed up), from the app's Settings or the first time the mic is
// tapped. Which model, and the player's speech languages, are kept per device.
import Foundation
import Nudge
import Observation

@MainActor @Observable
final class Speech {
    /// The models on offer, the one to start with first.
    let models = speechModels()
    /// The model dictation uses.
    var modelId: String {
        didSet {
            defaults.set(modelId, forKey: Self.modelKey)
            if oldValue != modelId { loaded = nil }
        }
    }
    /// The player's speech languages, as tags (`nb-NO`, `en-US`), the first preferred.
    var languages: [String] {
        didSet { defaults.set(languages, forKey: Self.languagesKey) }
    }
    /// The models on this device.
    private(set) var downloaded: Set<String> = []
    /// Downloads under way, from 0 to 1.
    private(set) var downloading: [String: Double] = [:]
    /// Why the last download or load failed.
    private(set) var problem: String?

    var model: SpeechModel? { models.first { $0.id == modelId } }
    /// Whether the model dictation uses is on this device.
    var ready: Bool { downloaded.contains(modelId) }

    @ObservationIgnored private var loaded: (id: String, transcriber: Task<SpeechTranscriber, Error>)?
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored let directory: URL
    private static let modelKey = "speech.model"
    private static let languagesKey = "speech.languages"

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = support.appendingPathComponent("Speech", isDirectory: true)
        let languages = defaults.stringArray(forKey: Self.languagesKey) ?? Self.deviceLanguages()
        self.languages = languages
        // Norwegian speakers get NB-Whisper; everyone else the model for every language.
        let norwegian = languages.contains { ["nb", "nn", "no"].contains(Self.language(of: $0)) }
        modelId = defaults.string(forKey: Self.modelKey) ?? (norwegian ? "nb-whisper-small" : "whisper-small")
        refresh()
    }

    func refresh() {
        downloaded = Set(models.map(\.id).filter { speechModelDownloaded(dir: directory.path, id: $0) })
    }

    /// Downloads a model, and the model that tells its languages apart; one cut short goes on
    /// where it stopped.
    func download(_ id: String) async {
        guard downloading[id] == nil else { return }
        downloading[id] = 0
        problem = nil
        defer { downloading[id] = nil }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var folder = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? folder.setResourceValues(values)
            let progress = DownloadProgress { [weak self] fraction in
                Task { @MainActor in
                    if self?.downloading[id] != nil { self?.downloading[id] = fraction }
                }
            }
            try await downloadSpeechModel(dir: directory.path, id: id, listener: progress)
        } catch {
            problem = error.localizedDescription
        }
        refresh()
    }

    /// Removes a model from this device, but not files the model in use still needs.
    func remove(_ id: String) {
        removeSpeechModel(dir: directory.path, id: id, keep: id == modelId ? [] : [modelId])
        if loaded?.id == id { loaded = nil }
        refresh()
    }

    /// The model dictation uses, loaded once, off the main thread: that takes a moment.
    func transcriber() async throws -> SpeechTranscriber {
        if let loaded, loaded.id == modelId { return try await loaded.transcriber.value }
        let (dir, id) = (directory.path, modelId)
        let task = Task.detached(priority: .userInitiated) { try SpeechTranscriber(dir: dir, id: id) }
        loaded = (id, task)
        do {
            return try await task.value
        } catch {
            if loaded?.id == id { loaded = nil }
            throw error
        }
    }

    /// Lets go of the loaded model, which holds a few hundred MB, as when memory runs low.
    func unload() {
        loaded = nil
    }

    /// The language of a tag: `nb` for `nb-NO`.
    static func language(of tag: String) -> String {
        String(tag.split(whereSeparator: { $0 == "-" || $0 == "_" }).first ?? Substring(tag)).lowercased()
    }

    /// A language's name in the player's own language: "norsk bokmål", "English".
    static func name(of tag: String) -> String {
        let locale = Locale(identifier: tag)
        return locale.localizedString(forLanguageCode: language(of: tag))?.localizedCapitalized ?? tag
    }

    /// The device's languages, and English, so a Norwegian phone listens for both; Norwegian as
    /// Bokmål, which is what `no` means to whisper.
    static func deviceLanguages() -> [String] {
        var languages: [String] = []
        for preferred in Locale.preferredLanguages + ["en-US"] {
            let tag = language(of: preferred) == "no" ? "nb-NO" : preferred
            if !languages.contains(where: { language(of: $0) == language(of: tag) }) {
                languages.append(tag)
            }
        }
        return languages
    }

    /// Languages to offer when adding one.
    static let common = [
        "nb-NO", "nn-NO", "en-US", "sv-SE", "da-DK", "de-DE", "fr-FR", "es-ES", "it-IT", "nl-NL",
        "pl-PL", "pt-BR", "fi-FI", "uk-UA", "ar-SA", "hi-IN", "ja-JP", "ko-KR", "zh-CN",
    ]
}

private final class DownloadProgress: SpeechDownloadListener, @unchecked Sendable {
    let report: @Sendable (Double) -> Void
    // Calls come one at a time, in order. A step per half percent: the download comes in many
    // small pieces.
    private var reported = -1
    init(_ report: @escaping @Sendable (Double) -> Void) { self.report = report }

    func onProgress(done: UInt64, total: UInt64) {
        guard total > 0 else { return }
        let step = Int(done * 200 / total)
        guard step != reported else { return }
        reported = step
        report(Double(done) / Double(total))
    }
}

/// Bytes as people read them: "235 MB".
func megabytes(_ bytes: UInt64) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
}
