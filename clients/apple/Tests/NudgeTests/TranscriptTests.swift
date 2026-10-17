import Nudge
import XCTest

final class TranscriptTests: XCTestCase {
    private func tool(_ name: String, details: String? = nil) -> Part {
        .tool(tool: ToolPart(
            callId: name, name: name, argsJson: "{}", status: .done, result: "ok", isError: nil,
            detailsJson: details, output: nil, truncated: nil))
    }

    private var timeline: [TimelineItem] {
        [
            .nudge(id: "n", text: "Watch w1: 2 new", firedAt: 1, privateTo: nil),
            .answer(id: "a1", status: .done, error: nil, parts: [
                .reasoning(text: "hm"), tool("call_api"), tool("browse", details: #"{"needsLogin":true}"#),
                .text(text: "Two new mails."),
            ], privateTo: nil),
            .approval(id: "ap", approvalId: "p0", summary: "Send", status: .done, decidedBy: "Bo", privateTo: nil),
            .answer(id: "a2", status: .done, error: nil, parts: [tool("call_api")], privateTo: nil),
            .answer(id: "a3", status: .running, error: nil, parts: [tool("call_api")], privateTo: nil),
            .marker(id: "m", kind: .reset),
        ]
    }

    func testTranscriptKeepsMessagesTextAndLogins() {
        let kept = timeline.transcript
        XCTAssertEqual(kept.map(\.id), ["a1", "a3", "m"])
        guard case .answer(_, _, _, let parts, _) = kept[0] else { return XCTFail() }
        XCTAssertEqual(parts.count, 2)
        guard case .answer(_, _, _, let running, _) = kept[1] else { return XCTFail() }
        XCTAssertTrue(running.isEmpty)
    }

    func testTranscriptKeepsSomeoneElsesPrivateAnswer() {
        let secret = TimelineItem.answer(
            id: "s", status: .done, error: nil, parts: [], privateTo: Player(id: "bo", displayName: "Bo", address: nil))
        XCTAssertEqual([secret].transcript, [secret])
    }

    func testActivityHasNudgesApprovalsToolsAndThinking() {
        let activity = timeline.activity
        XCTAssertEqual(activity.map(\.id), ["n", "a1", "ap", "a2", "a3"])
        guard case .answer(_, _, _, let parts, _) = activity[1] else { return XCTFail() }
        XCTAssertEqual(parts.count, 3)
    }
}
