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
