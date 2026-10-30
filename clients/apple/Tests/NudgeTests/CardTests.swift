import Nudge
import XCTest

final class CardTests: XCTestCase {
    private func tool(_ details: String?) -> ToolPart {
        ToolPart(
            callId: "c1", name: "show_ui", argsJson: "{}", status: .done, result: "ok", isError: nil,
            detailsJson: details, output: nil, truncated: nil)
    }

    private let details = #"""
        {"ui":{"v":1,"title":"Times","blocks":[{"type":"heading","text":"Free"},{"type":"hologram"},
        {"type":"kv","pairs":[{"label":"Where","value":"Oslo"}]},{"type":"divider"}],
        "fields":[{"name":"guests","label":"Guests","type":"number"},{"name":"kids","label":"Kids","type":"boolean","optional":true}],
        "buttons":[{"id":"go","label":"Book","style":"primary"},{"id":"no","label":"Cancel","skipsFields":true}]},
        "pressed":{"button":"go","by":{"id":"bo","displayName":"Bo"}}}
        """#

    func testReadsACardAndSkipsBlocksItDoesNotKnow() throws {
        let card = try XCTUnwrap(tool(details).card)
        XCTAssertEqual(card.title, "Times")
        XCTAssertEqual(card.blocks, [.heading("Free"), .keyValues([(label: "Where", value: "Oslo")]), .divider])
        XCTAssertEqual(card.fields.map(\.name), ["guests", "kids"])
        XCTAssertTrue(card.once)
        XCTAssertEqual(tool(details).pressed, UiPressed(button: "go", by: "Bo"))
        XCTAssertNil(tool(#"{"needsLogin":true}"#).card)
        XCTAssertNil(tool(#"{"ui":{"v":2,"title":"x"}}"#).card)
    }

    func testSendsTheFieldsAButtonTakes() throws {
        let card = try XCTUnwrap(tool(details).card)
        XCTAssertThrowsError(try card.valuesJson(for: card.buttons[0], values: [:])) {
            XCTAssertEqual($0 as? MissingField, MissingField(label: "Guests"))
        }
        let json = try XCTUnwrap(try card.valuesJson(for: card.buttons[0], values: ["guests": .number(4)]))
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(sent["guests"] as? Double, 4)
        XCTAssertEqual(sent["kids"] as? Bool, false)
        XCTAssertNil(try card.valuesJson(for: card.buttons[1], values: [:]))
    }

    func testTheTranscriptKeepsACard() {
        let answer = TimelineItem.answer(
            id: "a", status: .done, error: nil, parts: [.tool(tool: tool(details))], startedAt: nil,
            promptedBy: nil, privateTo: nil)
        XCTAssertEqual([answer].transcript.map(\.id), ["a"])
    }
}
