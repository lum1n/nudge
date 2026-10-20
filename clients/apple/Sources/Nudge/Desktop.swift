// The room's desktop, live, over the desktop extension's panel socket: PNGs of the parts of its
// screen that changed, its windows and apps, and taps, drags, scrolls and typing sent back. One
// viewer at a time drives it; the others watch until they take control. Nothing of it goes to a
// model: the desktop agent reads the apps' accessibility trees, not this.
import Foundation
import NudgeFFI
import Observation

/// A part of the desktop's screen that changed: a PNG of `width` by `height` screen pixels, to
/// draw at `x`, `y` over what was there, on a screen of `screenWidth` by `screenHeight`.
public struct DesktopPatch: Equatable, Sendable {
    public var png: Data
    public var x: Int
    public var y: Int
    public var width: Int
    public var height: Int
    public var screenWidth: Int
    public var screenHeight: Int
}

/// A window on the desktop: ``ObservedDesktop/raise(_:)`` brings it to the front.
public struct DesktopWindow: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var ref: String
    public var title: String
    public var app: String
    public var id: String { ref }

    public init(ref: String, title: String = "", app: String = "") {
        self.ref = ref
        self.title = title
        self.app = app
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ref = try container.decode(String.self, forKey: .ref)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        app = try container.decodeIfPresent(String.self, forKey: .app) ?? ""
    }
}

/// Who drives the desktop (`holder`, a display name), and whether it is this viewer.
public struct DesktopControl: Equatable, Sendable {
    public var holder: String?
    public var you: Bool
}

/// What an ``ObservedDesktop`` shows besides the screen: the socket's status, the screen's size
/// once known, the windows, the apps it can start, what the assistant is doing there now, who is
/// in control, and the last error.
public struct DesktopState: Equatable, Sendable {
    public var status: PanelStatus = .connecting
    public var screenWidth = 0
    public var screenHeight = 0
    public var windows: [DesktopWindow] = []
    public var apps: [String] = []
    public var working: String?
    public var control: DesktopControl?
    public var error: String?
}

/// The room's desktop, kept current; drive it with the methods here, while in control.
/// Coordinates are screen pixels, as in ``DesktopPatch``. `close()` when done.
@MainActor
public final class ObservedDesktop: Observed<DesktopState> {
    /// What changed on the screen, in order, for one reader to draw each over the last. The first
    /// after connecting is the whole screen.
    public let patches: AsyncStream<DesktopPatch>
    @ObservationIgnored fileprivate let changes: AsyncStream<DesktopPatch>.Continuation
    @ObservationIgnored fileprivate var panel: Panel?

    override init() {
        (patches, changes) = AsyncStream.makeStream()
        super.init()
    }

    /// `button` is `left`, `right` or `middle`.
    public func click(x: Int, y: Int, button: String = "left", double: Bool = false) {
        var fields: [String: JSONValue] = ["x": .number(Double(x)), "y": .number(Double(y)), "button": .string(button)]
        if double { fields["double"] = .bool(true) }
        panel?.input("click", fields)
    }

    /// Moves the pointer there, as a hover does: menus open on it.
    public func move(x: Int, y: Int) {
        panel?.input("move", ["x": .number(Double(x)), "y": .number(Double(y))])
    }

    /// Presses the left button at one point and lets go at another: selecting text, moving things.
    public func drag(fromX: Int, fromY: Int, toX: Int, toY: Int) {
        panel?.input("drag", [
            "from": .object(["x": .number(Double(fromX)), "y": .number(Double(fromY))]),
            "to": .object(["x": .number(Double(toX)), "y": .number(Double(toY))]),
        ])
    }

    /// Scrolls at a point; about 100 is one notch of a mouse wheel.
    public func scroll(x: Int, y: Int, dx: Double, dy: Double) {
        panel?.input("wheel", ["x": .number(Double(x)), "y": .number(Double(y)), "dx": .number(dx), "dy": .number(dy)])
    }

    /// Types text into the window under the pointer, as if on a keyboard.
    public func type(_ text: String) { panel?.input("text", ["text": .string(text)]) }

    /// Presses a key or combo, such as `Enter`, `Backspace`, `F2` or `ctrl+s`.
    public func press(_ keys: String) { panel?.input("key", ["key": .string(keys)]) }

    /// Starts one of ``DesktopState/apps``.
    public func launch(_ app: String) { panel?.input("launch", ["app": .string(app)]) }

    /// Brings a window to the front: the desktop has no window manager to click.
    public func raise(_ window: DesktopWindow) { panel?.input("raise", ["ref": .string(window.ref)]) }

    /// Takes control from whoever has it.
    public func takeControl() { panel?.input("take") }

    override public func close() {
        changes.finish()
        panel?.disconnect()
        panel = nil
        super.close()
    }
}

final class DesktopRelay: PanelListener, @unchecked Sendable {
    let relay: Relay<DesktopState>
    let changes: AsyncStream<DesktopPatch>.Continuation
    // Calls come one at a time, in order, so the state can be kept here, and the patches keep
    // their order.
    private var state = DesktopState()

    @MainActor
    init(_ observed: ObservedDesktop) {
        relay = Relay(observed)
        changes = observed.changes
    }

    func onStatus(status: PanelStatus) {
        state.status = status
        relay.deliver(state)
    }

    func onFrame(json: String) {
        guard let frame = JSONValue(json: json) else { return }
        let number = { (from: JSONValue?, key: String) in Int(from?[key]?.number ?? 0) }
        switch frame["type"]?.string {
        case "frame":
            guard let png = Data(base64Encoded: frame["data"]?.string ?? ""), let screen = frame["screen"] else { return }
            let patch = DesktopPatch(
                png: png, x: number(frame, "x"), y: number(frame, "y"), width: number(frame, "width"),
                height: number(frame, "height"), screenWidth: number(screen, "width"), screenHeight: number(screen, "height"))
            changes.yield(patch)
            guard state.screenWidth != patch.screenWidth || state.screenHeight != patch.screenHeight else { return }
            state.screenWidth = patch.screenWidth
            state.screenHeight = patch.screenHeight
        case "windows": state.windows = frame["windows"]?.decode([DesktopWindow].self) ?? state.windows
        case "apps": state.apps = frame["apps"]?.decode([String].self) ?? state.apps
        // The agent's step, as it starts it; empty once it is done.
        case "status": state.working = frame["text"]?.string.flatMap { $0.isEmpty ? nil : $0 }
        case "control":
            state.control = DesktopControl(holder: frame["holder"]?.string, you: frame["you"]?.bool ?? false)
            state.error = nil
        case "error": state.error = frame["message"]?.string
        default: return
        }
        relay.deliver(state)
    }
}

extension NudgeClient {
    /// The room's desktop; the room needs the desktop extension on, or the state closes with 4404.
    @MainActor
    public func observeDesktop(_ room: String) throws -> ObservedDesktop {
        let observed = ObservedDesktop()
        let panel = try openPanel(room: room, extension: "desktop", listener: DesktopRelay(observed))
        observed.panel = panel
        observed.stop = { panel.disconnect() }
        return observed
    }
}
