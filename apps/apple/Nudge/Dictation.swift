// One dictation into a composer: the microphone, 16 kHz mono, into a speech session (see
// Speech.swift), and the text it hears so far. The words appear after each pause, with a guess
// at what is still being said; the session writes out the rest when the player stops.
import AVFoundation
import Foundation
import Nudge
import Observation

@MainActor @Observable
final class Dictation {
    enum Phase: Equatable {
        case idle
        /// Loading the model: a moment, the first time.
        case loading
        case listening
        /// Stopped; the last words are being written out.
        case finishing
    }

    private(set) var phase = Phase.idle
    /// What it heard so far.
    private(set) var text = ""
    /// The language of the latest stretch, as a tag: `nb`, `en`.
    private(set) var language: String?
    /// How loud the microphone is, from 0 to 1.
    private(set) var level: Float = 0

    @ObservationIgnored private var session: SpeechSession?
    @ObservationIgnored private var engine: AVAudioEngine?
    /// Bumped by each start, so a session's late updates don't reach the next one.
    @ObservationIgnored private var generation = 0

    /// Asks for the microphone, loads the model and starts listening. Throws when the player
    /// said no to the microphone, or the model didn't load.
    func start(_ speech: Speech) async throws {
        guard phase == .idle else { return }
        generation += 1
        let generation = generation
        text = ""
        language = nil
        phase = .loading
        do {
            guard await AVAudioApplication.requestRecordPermission() else { throw DictationError.microphone }
            let transcriber = try await speech.transcriber()
            // Stopped while loading.
            guard self.generation == generation, phase == .loading else { return }
            let relay = DictationRelay { [weak self] update in
                Task { @MainActor in self?.receive(update, generation: generation) }
            }
            let session = transcriber.start(languages: speech.languages, listener: relay)
            try listen(into: session)
            self.session = session
            phase = .listening
        } catch {
            stopEngine()
            phase = .idle
            throw error
        }
    }

    /// Stops listening; the last words follow, then the phase is idle again.
    func stop() {
        switch phase {
        case .loading:
            generation += 1
            phase = .idle
        case .listening:
            stopEngine()
            session?.finish()
            phase = .finishing
        case .idle, .finishing:
            break
        }
    }

    /// Stops at once, keeping what was heard so far.
    func cancel() {
        generation += 1
        stopEngine()
        session?.cancel()
        session = nil
        phase = .idle
    }

    private func receive(_ update: SpeechUpdate, generation: Int) {
        guard generation == self.generation else { return }
        text = update.text
        language = update.language ?? language
        if update.done {
            session = nil
            stopEngine()
            phase = .idle
        }
    }

    private func listen(into session: SpeechSession) throws {
        #if os(iOS)
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audio.setActive(true, options: .notifyOthersOnDeactivation)
        #endif
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0,
            let whisper = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
            let converter = AVAudioConverter(from: format, to: whisper)
        else { throw DictationError.microphone }
        let meter = LevelMeter { [weak self] level in
            Task { @MainActor in self?.level = level }
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / format.sampleRate) + 32
            guard let converted = AVAudioPCMBuffer(pcmFormat: whisper, frameCapacity: capacity) else { return }
            var given = false
            var error: NSError?
            converter.convert(to: converted, error: &error) { _, status in
                if given {
                    status.pointee = .noDataNow
                    return nil
                }
                given = true
                status.pointee = .haveData
                return buffer
            }
            guard error == nil, let channel = converted.floatChannelData?[0] else { return }
            let samples = Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
            session.push(samples: samples)
            meter.measure(samples)
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    private func stopEngine() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        level = 0
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}

enum DictationError: LocalizedError {
    case microphone

    var errorDescription: String? {
        switch self {
        case .microphone: "Nudge may not use the microphone. Allow it in Settings, under Privacy & Security."
        }
    }
}

private final class DictationRelay: SpeechListener, @unchecked Sendable {
    let deliver: @Sendable (SpeechUpdate) -> Void
    init(_ deliver: @escaping @Sendable (SpeechUpdate) -> Void) { self.deliver = deliver }
    func onUpdate(update: SpeechUpdate) { deliver(update) }
}

/// The microphone's level, about ten times a second, for the mic button.
private final class LevelMeter: @unchecked Sendable {
    let report: @Sendable (Float) -> Void
    // Called on the audio thread only.
    private var samples = 0
    private var sum: Float = 0
    init(_ report: @escaping @Sendable (Float) -> Void) { self.report = report }

    func measure(_ chunk: [Float]) {
        for sample in chunk { sum += sample * sample }
        samples += chunk.count
        guard samples >= 1_600 else { return }
        let rms = (sum / Float(samples)).squareRoot()
        samples = 0
        sum = 0
        // Speech is about 0.01 to 0.3.
        report(min(1, max(0, (log10(max(rms, 1e-4)) + 2.5) / 2)))
    }
}
