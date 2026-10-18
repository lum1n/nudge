// Dictation through the bindings, with real models and audio: set NUDGE_SPEECH_DIR to a directory
// with nb-whisper-small.bin and whisper-base.bin (the speech models, as the apps download them)
// and NUDGE_SPEECH_WAV to a WAV file, 16-bit 16 kHz mono, of English speech. Skipped otherwise.
import Foundation
import Nudge
import XCTest

final class SpeechTests: XCTestCase {
    func testModelsAreOnOffer() {
        let models = speechModels()
        XCTAssertEqual(models.first?.id, "nb-whisper-small")
        XCTAssertEqual(models.first?.languages, ["no", "nn", "en"])
        // NB-Whisper comes with the model that tells its languages apart.
        XCTAssertEqual(models.first?.bytes, 175_209_680 + 59_707_625)
        XCTAssertFalse(speechModelDownloaded(dir: "/nonexistent", id: "nb-whisper-small"))
    }

    func testDictatesEnglish() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let dir = environment["NUDGE_SPEECH_DIR"], let wav = environment["NUDGE_SPEECH_WAV"] else {
            throw XCTSkip("set NUDGE_SPEECH_DIR and NUDGE_SPEECH_WAV")
        }
        XCTAssertTrue(speechModelDownloaded(dir: dir, id: "nb-whisper-small"))
        let transcriber = try SpeechTranscriber(dir: dir, id: "nb-whisper-small")
        let heard = Heard()
        let session = transcriber.start(languages: ["nb-NO", "en-US"], listener: heard)
        let data = try Data(contentsOf: URL(fileURLWithPath: wav))
        // The samples follow the "data" chunk's header; 16-bit little endian.
        let start = try XCTUnwrap(data.range(of: Data("data".utf8))).upperBound + 4
        let samples = stride(from: start, to: data.count - 1, by: 2).map { i in
            Float(Int16(bitPattern: UInt16(data[i]) | UInt16(data[i + 1]) << 8)) / 32768
        }
        for chunk in stride(from: 0, to: samples.count, by: 1600) {
            session.push(samples: Array(samples[chunk..<min(chunk + 1600, samples.count)]))
        }
        session.finish()
        wait(for: [heard.done], timeout: 120)
        let last = try XCTUnwrap(heard.last)
        XCTAssertNil(last.problem)
        XCTAssertEqual(last.language, "en")
        XCTAssertTrue(last.text.contains("what you can do for your country"), last.text)
    }
}

private final class Heard: SpeechListener, @unchecked Sendable {
    let done = XCTestExpectation(description: "the last update")
    private let lock = NSLock()
    private var updates: [SpeechUpdate] = []
    var last: SpeechUpdate? { lock.withLock { updates.last } }

    func onUpdate(update: SpeechUpdate) {
        lock.withLock { updates.append(update) }
        if update.done { done.fulfill() }
    }
}
