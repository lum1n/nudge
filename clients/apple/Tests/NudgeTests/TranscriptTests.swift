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
            ], startedAt: nil, promptedBy: .watch, privateTo: nil),
            .approval(id: "ap", approvalId: "p0", summary: "Send", status: .done, decidedBy: "Bo", privateTo: nil),
            .answer(id: "a2", status: .done, error: nil, parts: [tool("call_api")], startedAt: nil, promptedBy: nil, privateTo: nil),
            .answer(id: "a3", status: .running, error: nil, parts: [tool("call_api")], startedAt: nil, promptedBy: nil, privateTo: nil),
            .marker(id: "m", kind: .reset),
        ]
    }

    func testTranscriptKeepsMessagesTextAndLogins() {
        let kept = timeline.transcript
        XCTAssertEqual(kept.map(\.id), ["a1", "a3", "m"])
        guard case .answer(_, _, _, let parts, _, let promptedBy, _) = kept[0] else { return XCTFail() }
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(promptedBy, .watch)
        guard case .answer(_, _, _, let running, _, _, _) = kept[1] else { return XCTFail() }
        XCTAssertTrue(running.isEmpty)
    }

    func testTranscriptKeepsSomeoneElsesPrivateAnswer() {
        let secret = TimelineItem.answer(
            id: "s", status: .done, error: nil, parts: [], startedAt: nil, promptedBy: nil, privateTo: Player(id: "bo", displayName: "Bo", address: nil))
        XCTAssertEqual([secret].transcript, [secret])
    }

    func testActivityHasNudgesApprovalsToolsAndThinking() {
        let activity = timeline.activity
        XCTAssertEqual(activity.map(\.id), ["n", "a1", "ap", "a2", "a3"])
        guard case .answer(_, _, _, let parts, _, _, _) = activity[1] else { return XCTFail() }
        XCTAssertEqual(parts.count, 3)
    }

    func testDayStartsMarkTheFirstTimedItemOfEachDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Oslo")!
        let at = { (day: Int, hour: Int) in
            calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour))!.timeIntervalSince1970 * 1000
        }
        let user = { (id: String, sentAt: Double?) in
            TimelineItem.user(id: id, text: id, author: nil, sentAt: sentAt, clientId: nil, requestId: nil, privateTo: nil)
        }
        let answer = { (id: String, startedAt: Double?) in
            TimelineItem.answer(id: id, status: .done, error: nil, parts: [.text(text: id)], startedAt: startedAt, promptedBy: nil, privateTo: nil)
        }
        let items = [
            user("a", at(18, 9)), answer("b", at(18, 9)), .marker(id: "m", kind: .compacted),
            user("c", at(19, 23)), answer("d", nil), answer("e", at(20, 0)),
        ]
        XCTAssertEqual(items.dayStarts(in: calendar), ["a": at(18, 9), "c": at(19, 23), "e": at(20, 0)])
    }
}
