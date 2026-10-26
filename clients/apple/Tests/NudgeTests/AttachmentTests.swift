import Foundation
import Nudge
import XCTest

@MainActor
final class AttachmentTests: XCTestCase {
    func testScalesPhotosDownToTheLongSide() {
        XCTAssertEqual(attachmentImageMaxSide(), 2048)
        let size = ImageScaling.targetSize(width: 4032, height: 3024)
        XCTAssertEqual(size?.width, 2048)
        XCTAssertEqual(size?.height, 1536)
        let tall = ImageScaling.targetSize(width: 1000, height: 5000)
        XCTAssertEqual(tall?.width, 410)
        XCTAssertEqual(tall?.height, 2048)
        XCTAssertNil(ImageScaling.targetSize(width: 800, height: 600))
        XCTAssertEqual(ImageScaling.jpegName("IMG_0001.HEIC"), "IMG_0001.jpg")
    }

    func testSaysSizes() {
        XCTAssertEqual(sizeLabel(900), "900 B")
        XCTAssertEqual(sizeLabel(240 * 1024), "240 KB")
        XCTAssertEqual(sizeLabel(1_400_000), "1.3 MB")
    }

    private func attachment(_ name: String) -> Attachment {
        Attachment(id: "a-\(name)", name: name, mime: "text/plain", size: 1, kind: .file)
    }

    func testUploadsWhenPickedAndDeletesWhatIsTakenOff() async {
        var discarded: [String] = []
        let drafts = AttachmentDrafts(
            upload: { name, _, _ in self.attachment(name) },
            discard: { discarded.append($0) })
        await drafts.add(name: "a.txt", mime: "text/plain", data: Data("a".utf8))
        await drafts.add(name: "b.txt", mime: "text/plain", data: Data("b".utf8))
        XCTAssertEqual(drafts.ready.map(\.name), ["a.txt", "b.txt"])
        XCTAssertFalse(drafts.hasImages)
        drafts.remove(drafts.drafts[0].id)
        await Task.yield()
        XCTAssertEqual(discarded, ["a-a.txt"])
        XCTAssertEqual(drafts.take().map(\.name), ["b.txt"])
        XCTAssertTrue(drafts.drafts.isEmpty)
    }

    func testSaysWhyAnUploadWasRefused() async {
        let drafts = AttachmentDrafts(
            upload: { _, _, _ in throw NudgeError.Status(status: 400, detail: "The room's attachments are full") },
            discard: { _ in })
        await drafts.add(name: "big.bin", mime: "application/octet-stream", data: Data([1]))
        XCTAssertEqual(drafts.drafts.first?.state, .failed("The room's attachments are full"))
        XCTAssertTrue(drafts.take().isEmpty)
        // Too many for one message.
        for n in 0..<8 { await drafts.add(name: "\(n)", mime: "text/plain", data: Data()) }
        guard case .failed(let why) = drafts.drafts.last?.state else { return XCTFail() }
        XCTAssertEqual(why, "At most 8 files per message")
    }
}
