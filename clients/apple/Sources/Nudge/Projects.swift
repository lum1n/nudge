// The room's project, live, over the projects extension's panel socket: what the assistant builds
// with coding agents on the project's exe.dev VM, its milestones and tasks, and Pause and Resume.
// The extension sends the project on open and on every change; `null` when the room has none.
// Read leniently: unknown keys are ignored and missing ones get defaults.
import Foundation
import NudgeFFI
import Observation

private extension KeyedDecodingContainer {
    /// The value at `key`, or nil when it is missing or of another type.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }
}

/// A task's coding-agent session, on `host`; `state` as the agent reports it.
public struct ProjectSession: Decodable, Equatable, Hashable, Sendable {
    public var host: String
    public var id: String
    public var state: String?

    enum CodingKeys: String, CodingKey { case host, id, state }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = c.lenient(String.self, .host) ?? ""
        id = c.lenient(String.self, .id) ?? ""
        state = c.lenient(String.self, .state)
    }
}

/// A task's pull request; `ci` is `pending`, `passing` or `failing`.
public struct ProjectPr: Decodable, Equatable, Hashable, Sendable {
    public var url: String
    public var number: Int?
    public var ci: String?

    enum CodingKeys: String, CodingKey { case url, number, ci }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = c.lenient(String.self, .url) ?? ""
        number = c.lenient(Int.self, .number)
        ci = c.lenient(String.self, .ci)
    }
}

/// A task of a milestone. `status` is `todo`, `running`, `review`, `done`, `blocked` or
/// `skipped`; one with a `session` has an agent at work on it.
public struct ProjectTask: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var criteria: [String]
    public var status: String
    public var branch: String?
    public var session: ProjectSession?
    public var pr: ProjectPr?
    public var note: String?

    enum CodingKeys: String, CodingKey { case id, title, criteria, status, branch, session, pr, note }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        title = c.lenient(String.self, .title) ?? ""
        criteria = c.lenient([String].self, .criteria) ?? []
        status = c.lenient(String.self, .status) ?? "todo"
        branch = c.lenient(String.self, .branch)
        session = c.lenient(ProjectSession.self, .session)
        pr = c.lenient(ProjectPr.self, .pr)
        note = c.lenient(String.self, .note)
    }
}

/// A milestone; `status` is `planned`, `active`, `gate` (waiting for the person) or `merged`.
public struct ProjectMilestone: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var status: String
    public var tasks: [ProjectTask]

    enum CodingKeys: String, CodingKey { case id, title, status, tasks }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        title = c.lenient(String.self, .title) ?? ""
        status = c.lenient(String.self, .status) ?? "planned"
        tasks = c.lenient([ProjectTask].self, .tasks) ?? []
    }
}

/// The project's VM on exe.dev; `ready` once it is set up for agents.
public struct ProjectVm: Decodable, Equatable, Hashable, Sendable {
    public var name: String
    public var host: String
    public var ready: Bool

    enum CodingKeys: String, CodingKey { case name, host, ready }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.lenient(String.self, .name) ?? ""
        host = c.lenient(String.self, .host) ?? ""
        ready = c.lenient(Bool.self, .ready) ?? false
    }
}

/// A room's project. `status` is `planning`, `running`, `paused`, `gate` or `done`; `secrets` are
/// only the names of those it has. Spend is in US dollars; `updatedAt` ms since the epoch.
public struct ProjectView: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var status: String
    public var brief: String
    public var repo: String?
    public var milestones: [ProjectMilestone]
    public var vm: ProjectVm?
    public var secrets: [String]
    public var spendUsd: Double
    public var budgetUsd: Double?
    public var maxAgents: Int
    public var updatedAt: Double

    enum CodingKeys: String, CodingKey {
        case id, name, status, brief, repo, milestones, vm, secrets, spendUsd, budgetUsd, maxAgents, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        name = c.lenient(String.self, .name) ?? ""
        status = c.lenient(String.self, .status) ?? "planning"
        brief = c.lenient(String.self, .brief) ?? ""
        repo = c.lenient(String.self, .repo)
        milestones = c.lenient([ProjectMilestone].self, .milestones) ?? []
        vm = c.lenient(ProjectVm.self, .vm)
        secrets = c.lenient([String].self, .secrets) ?? []
        spendUsd = c.lenient(Double.self, .spendUsd) ?? 0
        budgetUsd = c.lenient(Double.self, .budgetUsd)
        maxAgents = c.lenient(Int.self, .maxAgents) ?? 0
        updatedAt = c.lenient(Double.self, .updatedAt) ?? 0
    }

    /// The tasks with an agent at work on them.
    public var liveTasks: [ProjectTask] { milestones.flatMap(\.tasks).filter { $0.session != nil } }
}

/// What an ``ObservedProject`` shows: the socket's status, whether the project came yet
/// (`loaded`), the project (nil when the room has none), and the last thing the extension refused.
public struct ProjectState: Equatable, Sendable {
    public var status: PanelStatus = .connecting
    public var loaded = false
    public var project: ProjectView?
    public var error: String?
}

/// The room's project, kept current; pause and resume it here. `close()` when done.
@MainActor
public final class ObservedProject: Observed<ProjectState> {
    @ObservationIgnored fileprivate var panel: Panel?
    @ObservationIgnored let requests = Requests()

    /// Stops starting agents; throws ``PanelRefusal`` if the extension refuses.
    public func pause() async throws {
        _ = try await requests.request(panel, "pause", [:])
    }

    public func resume() async throws {
        _ = try await requests.request(panel, "resume", [:])
    }

    override public func close() {
        panel?.disconnect()
        panel = nil
        super.close()
    }
}

final class ProjectRelay: PanelListener, @unchecked Sendable {
    let relay: Relay<ProjectState>
    let requests: Requests
    // Calls come one at a time, in order, so the state can be kept here.
    private var state = ProjectState()

    @MainActor
    init(_ observed: ObservedProject) {
        relay = Relay(observed)
        requests = observed.requests
    }

    func onStatus(status: PanelStatus) {
        requests.status(status)
        state.status = status
        relay.deliver(state)
    }

    func onFrame(json: String) {
        // An answer to Pause or Resume: a refusal is thrown where it was asked.
        guard let frame = JSONValue(json: json), !requests.answer(frame) else { return }
        switch frame["type"]?.string {
        case "project":
            switch frame["project"] {
            case nil, .null?: state.project = nil
            case let project?:
                guard let view = project.decode(ProjectView.self) else { return }
                state.project = view
            }
            state.loaded = true
        case "error": state.error = frame["message"]?.string
        default: return
        }
        relay.deliver(state)
    }
}

extension NudgeClient {
    /// The room's project; the room needs the projects extension on, or the state closes with 4404.
    @MainActor
    public func observeProject(_ room: String) throws -> ObservedProject {
        let observed = ObservedProject()
        let panel = try openPanel(room: room, extension: "projects", listener: ProjectRelay(observed))
        observed.panel = panel
        observed.stop = { panel.disconnect() }
        return observed
    }
}
