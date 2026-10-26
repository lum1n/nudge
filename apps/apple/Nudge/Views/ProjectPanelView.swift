import Nudge
import SwiftUI

/// The room's project, as the assistant runs it with coding agents: its status with Pause and
/// Resume, the brief, milestones and their tasks, the agents at work, its VM, secrets and spend.
struct ProjectPanelView: View {
    let client: NudgeClient
    let roomId: String
    @State private var project: ObservedProject?
    @State private var openingError: String?
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        content
            .navigationTitle(project?.value?.project.map { Text(verbatim: $0.name) } ?? Text("Project"))
            .onAppear {
                guard project == nil else { return }
                do {
                    project = try client.observeProject(roomId)
                } catch {
                    openingError = explain(error)
                }
            }
            .onDisappear {
                project?.close()
                project = nil
            }
    }

    @ViewBuilder private var content: some View {
        let state = project?.value
        if let openingError {
            ContentUnavailableView("Can't open the project", systemImage: "exclamationmark.triangle", description: Text(openingError))
        } else if case .closed(let code, _)? = state?.status, code == 4404 {
            ContentUnavailableView(
                "No projects here", systemImage: "hammer",
                description: Text("Turn on the projects extension for this room under Room."))
        } else if state?.loaded != true {
            ProgressView()
        } else if let view = state?.project {
            form(view, error: state?.error)
        } else {
            ContentUnavailableView("No project in this room", systemImage: "hammer")
        }
    }

    private func form(_ view: ProjectView, error: String?) -> some View {
        Form {
            if let message = problem ?? error {
                Text(message).foregroundStyle(.red)
            }
            Section {
                HStack {
                    projectStatus(view.status).font(.headline)
                    Spacer()
                    switch view.status {
                    case "running", "planning", "gate":
                        Button("Pause", systemImage: "pause.fill") { run { try await project?.pause() } }
                            .buttonStyle(.glass)
                            .disabled(busy)
                    case "paused":
                        Button("Resume", systemImage: "play.fill") { run { try await project?.resume() } }
                            .buttonStyle(.glassProminent)
                            .disabled(busy)
                    default:
                        EmptyView()
                    }
                }
                if !view.brief.isEmpty {
                    Text(view.brief)
                }
                if let repo = view.repo {
                    LabeledContent("Repository") {
                        if repo.hasPrefix("https://"), let url = URL(string: repo) {
                            Link(repo, destination: url)
                        } else {
                            Text(repo)
                        }
                    }
                }
            }
            ForEach(view.milestones) { milestone in
                Section {
                    if milestone.tasks.isEmpty {
                        Text("No tasks yet").foregroundStyle(.secondary)
                    }
                    ForEach(milestone.tasks) { task in ProjectTaskRow(task: task) }
                } header: {
                    HStack {
                        Text(milestone.title)
                        Spacer()
                        milestoneStatus(milestone.status)
                    }
                }
            }
            Section("Agents at work") {
                let live = view.liveTasks
                if live.isEmpty {
                    Text("No agents at work").foregroundStyle(.secondary)
                }
                ForEach(live) { task in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(task.title)
                        Text([task.session?.host, task.session?.state, task.branch].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if view.maxAgents > 0 {
                    Text("At most \(view.maxAgents) at a time").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let vm = view.vm {
                Section("VM") {
                    LabeledContent {
                        Text(vm.ready ? "Ready" : "Being set up")
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(vm.name)
                            Text(vm.host).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section("Secrets") {
                if view.secrets.isEmpty {
                    Text("None yet").foregroundStyle(.secondary)
                } else {
                    Text(view.secrets.joined(separator: ", "))
                }
            }
            Section("Spend") {
                let spent = view.spendUsd.formatted(.currency(code: "USD"))
                if let budget = view.budgetUsd {
                    Text("\(spent) of \(budget.formatted(.currency(code: "USD")))")
                } else {
                    Text(spent)
                }
            }
        }
        .formStyle(.grouped)
    }

    private func run(_ action: @escaping () async throws -> Void) {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await action()
                problem = nil
            } catch {
                problem = explain(error)
            }
        }
    }
}

/// A task of a milestone: its status, note, and pull request, which opens in the browser.
private struct ProjectTaskRow: View {
    let task: ProjectTask

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(task.title)
                Spacer()
                taskStatus(task.status)
                    .font(.caption.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(.fill.tertiary, in: .capsule)
            }
            if let note = task.note {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
            if let pr = task.pr, pr.url.hasPrefix("https://"), let url = URL(string: pr.url) {
                HStack(spacing: 6) {
                    Link(destination: url) {
                        Label {
                            if let number = pr.number { Text("Pull request #\(number)") } else { Text("Pull request") }
                        } icon: {
                            Image(systemName: "arrow.up.right.square")
                        }
                    }
                    switch pr.ci {
                    case "pending": Text("checks running").foregroundStyle(.secondary)
                    case "passing": Text("checks pass").foregroundStyle(.green)
                    case "failing": Text("checks fail").foregroundStyle(.red)
                    default: EmptyView()
                    }
                }
                .font(.caption)
            }
        }
    }
}

private func projectStatus(_ status: String) -> Text {
    switch status {
    case "planning": Text("Planning")
    case "running": Text("Running")
    case "paused": Text("Paused")
    case "gate": Text("Waiting for you")
    case "done": Text("Done")
    default: Text(verbatim: status)
    }
}

private func milestoneStatus(_ status: String) -> Text {
    switch status {
    case "planned": Text("Planned")
    case "active": Text("Active")
    case "gate": Text("Waiting for you")
    case "merged": Text("Merged")
    default: Text(verbatim: status)
    }
}

private func taskStatus(_ status: String) -> Text {
    switch status {
    case "todo": Text("To do")
    case "running": Text("Running")
    case "review": Text("In review")
    case "done": Text("Done")
    case "blocked": Text("Blocked")
    case "skipped": Text("Skipped")
    default: Text(verbatim: status)
    }
}
