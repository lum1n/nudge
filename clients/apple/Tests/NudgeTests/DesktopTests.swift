import Foundation
@testable import Nudge
import XCTest

@MainActor
final class DesktopTests: XCTestCase {
    func testPatchesComeInOrderWithTheScreenSize() async throws {
        let desktop = ObservedDesktop()
        let relay = DesktopRelay(desktop)
        let whole = Data([1, 2, 3])
        let part = Data([4])
        relay.onFrame(json: #"{"type":"frame","data":"\#(whole.base64EncodedString())","x":0,"y":0,"width":1280,"height":800,"screen":{"width":1280,"height":800}}"#)
        relay.onFrame(json: #"{"type":"frame","data":"\#(part.base64EncodedString())","x":64,"y":87,"width":32,"height":20,"screen":{"width":1280,"height":800}}"#)
        desktop.close()
        var patches: [DesktopPatch] = []
        for await patch in desktop.patches { patches.append(patch) }
        XCTAssertEqual(patches.map(\.png), [whole, part])
        XCTAssertEqual([patches[1].x, patches[1].y, patches[1].width, patches[1].height], [64, 87, 32, 20])
        let state = try await desktop.first { $0.screenWidth > 0 }
        XCTAssertEqual([state.screenWidth, state.screenHeight], [1280, 800])
    }

    func testKeepsWindowsAppsAndWhatTheAssistantDoes() async throws {
        let desktop = ObservedDesktop()
        let relay = DesktopRelay(desktop)
        relay.onFrame(json: #"{"type":"apps","apps":["editor","calc"]}"#)
        relay.onFrame(json: #"{"type":"windows","windows":[{"ref":"e1","title":"Notes","app":"python3"}]}"#)
        relay.onFrame(json: #"{"type":"status","text":"Clicking button \"Save\""}"#)
        relay.onFrame(json: #"{"type":"control","holder":"Bo","you":false}"#)
        var state = try await desktop.first { $0.control != nil }
        XCTAssertEqual(state.apps, ["editor", "calc"])
        XCTAssertEqual(state.windows, [DesktopWindow(ref: "e1", title: "Notes", app: "python3")])
        XCTAssertEqual(state.working, #"Clicking button "Save""#)
        XCTAssertEqual(state.control, DesktopControl(holder: "Bo", you: false))

        relay.onFrame(json: #"{"type":"status","text":""}"#)
        relay.onFrame(json: #"{"type":"error","message":"There is no app called \"x\"."}"#)
        state = try await desktop.first { $0.error != nil }
        XCTAssertNil(state.working)
        XCTAssertEqual(state.error, #"There is no app called "x"."#)
        desktop.close()
    }
}
