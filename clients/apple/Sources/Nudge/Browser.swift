// The room's browser, live, over the browser extension's panel socket: JPEG frames of its tab,
// and taps, scrolls and typing sent back. One viewer at a time drives it; the others watch until
// they take control. What is typed here goes to the browser only, and `done` can save a login
// typed here so the assistant logs in by itself next time. Nothing of it goes to a model.
import Foundation
import NudgeFFI
import Observation

/// A frame of the browser's tab: a JPEG of `width` by `height` page pixels, and its address.
public struct BrowserFrame: Equatable, Sendable {
    public var jpeg: Data
    public var width: Int
    public var height: Int
    public var url: String
}

/// A login the browser keeps for the room; its password never leaves the server.
public struct SavedLogin: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var host: String
    public var username: String?
    /// Milliseconds since the epoch.
    public var savedAt: Double
    public var id: String { host }
}

/// Who drives the browser (`holder`, a display name), and whether it is this viewer.
public struct BrowserControl: Equatable, Sendable {
    public var holder: String?
    public var you: Bool
}

/// What an ``ObservedBrowser`` shows: the socket's status, the latest frame, who is in control,
/// the hosts whose logins the last `done` saved, the saved logins, and the last error.
public struct BrowserState: Equatable, Sendable {
    public var status: PanelStatus = .connecting
    public var frame: BrowserFrame?
    public var control: BrowserControl?
    public var saved: [String]?
    public var logins: [SavedLogin]?
    public var error: String?
}

/// The room's browser, kept current; drive it with the methods here, while in control.
/// Coordinates are page pixels, as in ``BrowserFrame``. `close()` when done.
@MainActor
public final class ObservedBrowser: Observed<BrowserState> {
    @ObservationIgnored fileprivate var panel: Panel?

    /// `button` is `left`, `right` or `middle`.
    public func click(x: Int, y: Int, button: String = "left", double: Bool = false) {
        var fields: [String: JSONValue] = ["x": .number(Double(x)), "y": .number(Double(y)), "button": .string(button)]
        if double { fields["double"] = .bool(true) }
        panel?.input("click", fields)
    }

    public func scroll(x: Int, y: Int, dx: Double, dy: Double) {
        panel?.input("wheel", ["x": .number(Double(x)), "y": .number(Double(y)), "dx": .number(dx), "dy": .number(dy)])
    }

    /// Types text into the page, as if on a keyboard.
    public func type(_ text: String) { panel?.input("text", ["text": .string(text)]) }

    /// Presses a key by its name, such as `Enter`, `Backspace`, `Tab` or `Control+A`.
    public func press(_ key: String) { panel?.input("key", ["key": .string(key)]) }

    public func navigate(to url: String) { panel?.input("navigate", ["url": .string(url)]) }
    public func back() { navigate(to: "back") }

    /// Finished, such as logging in; with `remember`, a login typed here is saved for the room.
    public func done(remember: Bool) { panel?.input("done", ["remember": .bool(remember)]) }

    /// Takes control from whoever has it.
    public func takeControl() { panel?.input("take") }

    public func forget(_ login: SavedLogin) { panel?.input("forget", ["host": .string(login.host)]) }

    override public func close() {
        panel?.disconnect()
        panel = nil
        super.close()
    }
}

private final class BrowserRelay: PanelListener, @unchecked Sendable {
    let relay: Relay<BrowserState>
    // Calls come one at a time, in order, so the state can be kept here.
    private var state = BrowserState()
    init(_ relay: Relay<BrowserState>) { self.relay = relay }

    func onStatus(status: PanelStatus) {
        state.status = status
        relay.deliver(state)
    }

    func onFrame(json: String) {
        guard let frame = JSONValue(json: json) else { return }
        switch frame["type"]?.string {
        case "frame":
            guard let jpeg = Data(base64Encoded: frame["data"]?.string ?? "") else { return }
            // A new page: the last error was about the one before.
            if state.frame?.url != frame["url"]?.string { state.error = nil }
            state.frame = BrowserFrame(
                jpeg: jpeg, width: Int(frame["width"]?.number ?? 0), height: Int(frame["height"]?.number ?? 0),
                url: frame["url"]?.string ?? "")
        case "control":
            state.control = BrowserControl(holder: frame["holder"]?.string, you: frame["you"]?.bool ?? false)
            state.error = nil
        case "done": state.saved = frame["saved"]?.decode([String].self)
        case "logins": state.logins = frame["logins"]?.decode([SavedLogin].self)
        case "error": state.error = frame["message"]?.string
        default: return
        }
        relay.deliver(state)
    }
}

extension NudgeClient {
    /// The room's browser; the room needs the browser extension on, or the state closes with 4404.
    @MainActor
    public func observeBrowser(_ room: String) throws -> ObservedBrowser {
        let observed = ObservedBrowser()
        let panel = try openPanel(room: room, extension: "browser", listener: BrowserRelay(Relay(observed)))
        observed.panel = panel
        observed.stop = { panel.disconnect() }
        return observed
    }
}

extension ToolPart {
    /// Whether the call is the browser stopping for a login the user has to type in the live view.
    public var needsLogin: Bool {
        guard name == "browse", let details = detailsJson.flatMap(JSONValue.init(json:)) else { return false }
        return details["needsLogin"]?.bool == true
    }
}
