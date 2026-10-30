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

    func testReadsMapsChartsAndTheOtherNewBlocks() throws {
        let card = try XCTUnwrap(tool(#"""
            {"ui":{"v":1,"blocks":[
            {"type":"map","markers":[{"lat":59.91,"lon":10.75,"label":"Oslo S"}],"path":[{"lat":59.9,"lon":10.7},{"lat":60,"lon":10.8}]},
            {"type":"chart","kind":"line","labels":["Jan","Feb"],"series":[{"name":"kr","values":[3,null]}],"unit":"kr"},
            {"type":"stats","items":[{"label":"Spent","value":"4 200 kr","change":"+12%","tone":"bad"}]},
            {"type":"progress","items":[{"label":"Saved","value":3}]},
            {"type":"timeline","items":[{"title":"Left","state":"done"}]}]}}
            """#).card)
        XCTAssertEqual(card.blocks.count, 5)
        guard case .map(let markers, let path) = card.blocks[0] else { return XCTFail("not a map") }
        XCTAssertEqual(markers.map(\.label), ["Oslo S"])
        XCTAssertEqual(path.map(\.lat), [59.9, 60])
        guard case .chart(let chart) = card.blocks[1] else { return XCTFail("not a chart") }
        XCTAssertEqual(chart.series[0].values, [3, nil])
        XCTAssertEqual(chart.unit, "kr")
        guard case .stats(let stats) = card.blocks[2] else { return XCTFail("not stats") }
        XCTAssertEqual(stats[0].tone, "bad")
        guard case .progress(let bars) = card.blocks[3] else { return XCTFail("not progress") }
        XCTAssertEqual(bars[0].max, 100)
        guard case .timeline(let steps) = card.blocks[4] else { return XCTFail("not a timeline") }
        XCTAssertEqual(steps[0].state, "done")
    }
}
