import Foundation
@testable import Nudge
import XCTest

@MainActor
final class ProjectTests: XCTestCase {
    func testReadsTheProjectLeniently() async throws {
        let project = ObservedProject()
        let relay = ProjectRelay(project)
        relay.onFrame(json: #"{"type":"project","project":null}"#)
        var state = try await project.first { $0.loaded }
        XCTAssertNil(state.project)

        relay.onFrame(json: #"""
            {"type":"project","project":{"id":"p1","name":"Shop","status":"someday","brief":"A shop","new":1,
            "milestones":[{"id":"m1","title":"MVP","status":"active","tasks":[
              {"id":"t1","title":"Cart","criteria":["adds"],"status":"running","session":{"host":"vm","id":"s1"},"pr":{"url":"https://x/1","number":1,"ci":"flaky"}},
              {"id":"t2","title":"Pay","status":"todo","pr":null,"criteria":"oops"}]}],
            "vm":{"name":"shop","host":"shop.exe.xyz","ready":true},"secrets":["GH"],"spendUsd":1.5,"maxAgents":2,"updatedAt":5}}
            """#)
        state = try await project.first { $0.project != nil }
        let view = try XCTUnwrap(state.project)
        XCTAssertEqual(view.status, "someday")
        XCTAssertEqual(view.liveTasks.map(\.id), ["t1"])
        XCTAssertEqual(view.milestones[0].tasks[0].pr?.ci, "flaky")
        XCTAssertEqual(view.milestones[0].tasks[1].criteria, [])
        XCTAssertNil(view.budgetUsd)
        XCTAssertEqual(view.secrets, ["GH"])
        XCTAssertEqual(view.vm?.ready, true)
        project.close()
    }
}
