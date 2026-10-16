// The bindings against a Nudge server on a faux model (`packages/server/scripts/faux-server.ts`,
// which runs the built packages: `pnpm build` first). Skipped without node or the build.
import Foundation
import Nudge
import XCTest

struct FauxServer {
    let url: String
    let ann: String
    let bo: String
    let process: Process
}

@MainActor
final class ClientTests: XCTestCase {
    var server: FauxServer!
    var clients: [NudgeClient] = []

    override func setUp() async throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().appendingPathComponent("../../../..").standardized
        let dist = repository.appendingPathComponent("packages/server/dist/index.js")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: dist.path), "no packages/server/dist")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "packages/server/scripts/faux-server.ts"]
        process.currentDirectoryURL = repository
        let output = Pipe()
        process.standardOutput = output
        process.standardInput = Pipe()
        try process.run()
        var line = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty, byte != Data("\n".utf8) {
            line.append(byte)
        }
        let started = try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any], "node didn't start the server")
        let tokens = try XCTUnwrap(started["tokens"] as? [String: String])
        server = FauxServer(url: started["url"] as! String, ann: tokens["ann"]!, bo: tokens["bo"]!, process: process)
    }

    override func tearDown() async throws {
        for client in clients { client.disconnect() }
        clients = []
        server?.process.terminate()
    }

    func client(_ tokens: TokenStore) throws -> NudgeClient {
        let config = ClientConfig(
            server: server.url, assistant: "robin", clientName: "nudge-swift-test", clientVersion: "0",
            platform: "swift", cachePath: nil)
        let client = try NudgeClient(config: config, tokens: tokens)
        client.connect()
        clients.append(client)
        return client
    }

    func within<T: Sendable>(_ seconds: Double = 15, _ body: @escaping @MainActor () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await body() }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                throw CancellationError()
            }
            let value = try await group.next()!
            group.cancelAll()
            return value
        }
    }

    func testListsPanelAndUsage() async throws {
        let ann = try client(MemoryTokens(server.ann))
        let usage = try await ann.usage()
        XCTAssertEqual(usage.month.count, 7)
        let lists = try ann.observeLists("trip")
        _ = try await within { try await lists.first { $0.lists == [] } }
        lists.add("Milk", to: "Shopping")
        let shown = try await within { try await lists.first { $0.lists?.first?.items.count == 1 } }
        let item = try XCTUnwrap(shown.lists?.first?.items.first)
        XCTAssertEqual(shown.lists?.first?.name, "shopping")
        XCTAssertEqual(item.text, "Milk")
        lists.toggle(item, in: "shopping")
        _ = try await within { try await lists.first { $0.lists?.first?.items.first?.done == true } }
        lists.remove(item, from: "nope")
        _ = try await within { try await lists.first { $0.error != nil } }
        lists.close()

        let nowhere = try ann.observeLists("nowhere")
        let closed = try await within {
            try await nowhere.first { if case .closed = $0.status { true } else { false } }
        }
        XCTAssertEqual(closed.status, .closed(code: 4404, reason: #"No room "nowhere" with extension "lists""#))
    }

    func testDocumentsPanel() async throws {
        let bo = try client(MemoryTokens(server.bo))
        let documents = try bo.observeDocuments("trip")
        _ = try await within { try await documents.first { $0.documents == [] } }
        let receipt = Data("Receipt: one bicycle, 4000 kr".utf8)
        let id = try await documents.upload(name: "receipt.txt", mime: "text/plain", data: receipt)
        let shown = try await within { try await documents.first { $0.documents?.count == 1 } }
        let document = try XCTUnwrap(shown.documents?.first)
        XCTAssertEqual(document.id, id)
        XCTAssertEqual(document.name, "receipt.txt")
        XCTAssertEqual(document.addedBy, "Bo")
        XCTAssertEqual(document.size, receipt.count)
        let file = try await documents.download(document)
        XCTAssertEqual(file.data, receipt)
        do {
            try await documents.upload(name: "again.txt", mime: "text/plain", data: receipt)
            XCTFail("not refused")
        } catch let refusal as PanelRefusal {
            XCTAssertTrue(refusal.message.contains("here already"))
        }
        documents.remove(document)
        _ = try await within { try await documents.first { $0.documents?.isEmpty == true } }
        documents.close()
    }

    func testConnectorsPanel() async throws {
        let bo = try client(MemoryTokens(server.bo))
        let room = bo.observeRoomState("trip")
        _ = try await within { try await room.first { $0.status == .live } }
        // The model asks to add "Weather"; it needs an approval.
        _ = try await bo.send(room: "trip", text: "Please add a connector for the weather", whenBusy: nil)
        let waiting = try await within { try await room.first { $0.approvals.contains { $0.status == .pending } } }
        _ = try await bo.decide(room: "trip", approvalId: waiting.approvals[0].id, approve: true)
        room.close()

        let connectors = try bo.observeConnectors("trip")
        let shown = try await within { try await connectors.first { $0.connectors?.count == 1 } }
        let weather = try XCTUnwrap(shown.connectors?.first)
        XCTAssertEqual(weather.name, "Weather")
        XCTAssertEqual(weather.auth?.placement, "header")
        XCTAssertFalse(weather.hasKey)
        XCTAssertFalse(shown.admin)
        connectors.setKey("secret-key", for: weather)
        _ = try await within { try await connectors.first { $0.connectors?.first?.hasKey == true } }
        connectors.allowPrivateNetwork(true, for: weather)
        _ = try await within { try await connectors.first { $0.connectors?.first?.allowPrivateNetwork == true } }
        connectors.setReadPaths(["POST /graphql"], for: weather)
        _ = try await within { try await connectors.first { $0.connectors?.first?.readPaths == ["POST /graphql"] } }
        connectors.setReadPaths(["GET /x"], for: weather)
        _ = try await within { try await connectors.first { $0.error != nil } }
        connectors.clearKey(of: weather)
        _ = try await within { try await connectors.first { $0.connectors?.first?.hasKey == false && $0.error == nil } }
        connectors.remove(weather)
        _ = try await within { try await connectors.first { $0.connectors?.isEmpty == true } }
        connectors.close()
    }

    func testPairingLinks() {
        let link = PairingLink(URL(string: "nudge://pair?server=https%3A%2F%2Fnudge.example%2Fx&assistant=robin&code=7K3Q-M9XD")!)
        XCTAssertEqual(link, PairingLink(server: "https://nudge.example/x", assistant: "robin", code: "7K3Q-M9XD"))
        for bad in [
            "nudge://pair?server=ftp%3A%2F%2Fx&assistant=robin&code=1",
            "nudge://pair?server=https%3A%2F%2Fx&code=1",
            "nudge://other?server=https%3A%2F%2Fx&assistant=robin&code=1",
            "https://pair?server=https%3A%2F%2Fx&assistant=robin&code=1",
        ] {
            XCTAssertNil(PairingLink(URL(string: bad)!), bad)
        }
    }

    func testApplyingChanges() {
        func marker(_ id: String) -> TimelineItem { .marker(id: id, kind: .reset) }
        let timeline = [TimelineItem]().applying([
            .reset(items: [marker("a"), marker("c")]),
            .insert(index: 1, item: marker("b")),
            .append(items: [marker("d")]),
            .set(index: 3, item: marker("e")),
            .remove(index: 0),
        ])
        XCTAssertEqual(timeline.map(\.id), ["b", "c", "e"])
    }

    func testPairingAndAStreamedAnswer() async throws {
        let assistants = try await listAssistants(server: server.url)
        XCTAssertEqual(assistants.map(\.name), ["robin"])
        let admin = try client(MemoryTokens(server.ann))
        let me = try await admin.me()
        XCTAssertTrue(me.admin)

        let cy = try await admin.createPlayer(displayName: "Cy")
        let code = try await admin.pairingCode(playerId: cy.id)
        let tokens = MemoryTokens()
        let paired = try client(tokens)
        let pairing = try await paired.pair(code: code.code)
        XCTAssertEqual(pairing.player.id, cy.id)
        XCTAssertNotNil(tokens.get())
        let connection = paired.observeConnectionState()
        let open = try await within { try await connection.first { if case .open = $0 { true } else { false } } }
        guard case .open(let player, _, _) = open else { return XCTFail() }
        XCTAssertEqual(player.id, cy.id)

        let room = admin.observeRoomState("trip")
        let live = try await within { try await room.first { $0.status == .live } }
        XCTAssertEqual(live.room?.name, "Trip")

        let sent = try await admin.send(room: "trip", text: "Hello there", whenBusy: nil)
        guard case .delivered = sent else { return XCTFail("not delivered: \(sent)") }

        var texts: [String] = []
        let done = try await within {
            try await room.first { state in
                guard case .answer(_, let status, _, let parts) = state.timeline.first(where: { if case .answer = $0 { true } else { false } }) else { return false }
                texts.append(parts.map { if case .text(let text) = $0 { text } else { "" } }.joined())
                return status == .done
            }
        }
        XCTAssertTrue(texts.last!.hasPrefix("Hello! This answer arrives"))
        XCTAssertGreaterThan(Set(texts).count, 2, "streamed in several states")
        XCTAssertEqual(done.timeline.compactMap { if case .user(_, let text, _, _, _, _) = $0 { text } else { nil } }, ["Hello there"])
        XCTAssertTrue(done.pending.isEmpty)

        let fact = try await admin.remember(room: "trip", text: "Bo likes trains")
        let remembered = try await within { try await room.first { $0.memory.count == 1 } }
        XCTAssertEqual(remembered.memory[0].text, "Bo likes trains")
        try await admin.forget(room: "trip", factId: fact.id)
        _ = try await within { try await room.first { $0.memory.isEmpty } }
        room.close()

        let home = admin.observeHomeState()
        let view = try await within { try await home.first { $0.view != nil } }
        XCTAssertTrue(view.view!.rooms.contains { $0.room.id == "trip" })
    }

    func testApprovalsAndNudges() async throws {
        let admin = try client(MemoryTokens(server.ann))
        let member = try client(MemoryTokens(server.bo))
        let room = member.observeRoomState("trip")
        _ = try await within { try await room.first { $0.status == .live } }

        // The model's `pay` waits for someone in the room to approve.
        _ = try await admin.send(room: "trip", text: "Please pay the bill", whenBusy: nil)
        let asked = try await within { try await room.first { $0.approvals.contains { $0.status == .pending } } }
        let approval = asked.approvals[0]
        XCTAssertEqual(approval.summary, "Pay 10 kr")
        let decided = try await member.decide(room: "trip", approvalId: approval.id, approve: true)
        XCTAssertEqual(decided.decidedBy?.id, "bo")
        let done = try await within { try await room.first { $0.approvals.first?.status == .done } }
        XCTAssertEqual(done.approvals[0].result, "Paid 10 kr.")
        do {
            _ = try await admin.decide(room: "trip", approvalId: approval.id, approve: false)
            XCTFail("not refused")
        } catch NudgeError.Status(let status, _) {
            XCTAssertEqual(status, 409)
        }

        // The model's `schedule_nudge` shows in the room and on the home view.
        _ = try await admin.send(room: "trip", text: "Remind me to water the plants", whenBusy: nil)
        let scheduled = try await within { try await room.first { $0.nudges.count == 1 } }.nudges[0]
        XCTAssertEqual(scheduled.message, "Water the plants")
        let home = admin.observeHomeState()
        let view = try await within { try await home.first { $0.view?.nudges.count == 1 } }
        XCTAssertEqual(view.view!.nudges[0].roomId, "trip")
        try await member.cancelNudge(nudgeId: scheduled.id)
        _ = try await within { try await room.first { $0.nudges.isEmpty } }
        do {
            try await member.cancelNudge(nudgeId: scheduled.id)
            XCTFail("not refused")
        } catch NudgeError.Status(let status, _) {
            XCTAssertEqual(status, 404)
        }
        room.close()
    }

    func testOwnMemoryAndRoomExtensions() async throws {
        let member = try client(MemoryTokens(server.bo))
        let fact = try await member.rememberForMe(text: "Likes coffee")
        XCTAssertEqual(fact.by?.id, "bo")
        let memory = try await member.myMemory()
        XCTAssertEqual(memory.facts.map(\.id), [fact.id])
        XCTAssertFalse(memory.shared)
        let shared = try await member.shareMyMemory(shared: true)
        XCTAssertTrue(shared.shared)
        _ = try await member.shareMyMemory(shared: false)
        try await member.forgetForMe(factId: fact.id)
        let forgotten = try await member.myMemory()
        XCTAssertTrue(forgotten.facts.isEmpty)

        let extensions = try await member.roomExtensions(room: "trip")
        let payer = try XCTUnwrap(extensions.first { $0.name == "payer" })
        XCTAssertTrue(payer.enabled && payer.byDefault)
        let off = try await member.setRoomExtension(room: "trip", extension: "payer", enabled: false)
        XCTAssertFalse(off.enabled)
        XCTAssertTrue(off.byDefault)
        let back = try await member.setRoomExtension(room: "trip", extension: "payer", enabled: nil)
        XCTAssertTrue(back.enabled)
    }

    func testRefusalsAndRevocation() async throws {
        let admin = try client(MemoryTokens(server.ann))
        let member = try client(MemoryTokens(server.bo))
        do {
            _ = try await member.createPlayer(displayName: "Dee")
            XCTFail("not refused")
        } catch NudgeError.Status(let status, _) {
            XCTAssertEqual(status, 403)
        }

        let nowhere = member.observeRoomState("nowhere")
        do {
            _ = try await member.send(room: "nowhere", text: "hi", whenBusy: nil)
            XCTFail("not refused")
        } catch NudgeError.Status(let status, _) {
            XCTAssertEqual(status, 404)
        }
        let failed = try await within { try await nowhere.first { !$0.pending.isEmpty } }
        guard case .failed = failed.pending[0].state else { return XCTFail() }

        let connection = member.observeConnectionState()
        let open = try await within { try await connection.first { if case .open = $0 { true } else { false } } }
        guard case .open(_, let clientId, _) = open else { return XCTFail() }
        try await admin.revoke(clientId: clientId)
        let closed = try await within {
            try await connection.first { if case .closed(let code, _) = $0 { code != 1000 } else { false } }
        }
        guard case .closed(let code, _) = closed else { return XCTFail() }
        XCTAssertEqual(code, 4401)
    }
}
