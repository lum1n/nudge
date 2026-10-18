import Nudge
import SwiftUI

/// A server's Wired: an encrypted network between the person's servers that needs no open port at
/// home. Home holds the network; a server with a public HTTPS address, such as one on exe.dev,
/// joins it and serves a relay there, through which they reach each other. A server too old for it
/// says so, with a check for the release that has it.
struct WiredSection: View {
    @Environment(AppModel.self) private var model
    let server: String
    @State private var state: WiredState?
    /// Another owned server that holds a network this one can join, once looked up.
    @State private var root: String?
    @State private var busy = false
    @State private var problem: String?
    /// Why the server can't run Wired, when it answered that it can't.
    @State private var unsupported: String?
    @State private var turningOff = false
    /// The Wired name to make the home's address, while asking.
    @State private var usingAddress: String?

    var body: some View {
        // Always one section, so the task below runs: on a view with nothing in it, it wouldn't.
        Section {
            if let unsupported {
                Text(unsupported).foregroundStyle(.secondary)
                Button(busy ? "Checking…" : "Check for updates", systemImage: "arrow.down.circle") {
                    Task { await checkUpdates() }
                }
                .disabled(busy)
            } else if let state {
                row(state)
            } else if problem == nil {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Checking Wired…").foregroundStyle(.secondary)
                }
            }
            if let problem {
                Text(problem).foregroundStyle(unsupported == nil ? Color.red : Color.secondary)
            }
        } header: {
            Text("Wired")
        } footer: {
            Text("Your servers reach each other over Wired, encrypted, with no port open at home: home holds the network, and servers with a public address join it.")
        }
        .alert("Turn off Wired here?", isPresented: $turningOff) {
            Button("Turn off", role: .destructive) {
                Task { await act { try await model.servers.client(server).disableWired() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(state?.state == .root
                ? "Your servers stop reaching each other through this network."
                : "This server leaves the network, and stops reaching your other servers through it.")
        }
        .alert(
            "Use http://nudge.\(usingAddress ?? "").wired as your home's address?",
            isPresented: Binding(get: { usingAddress != nil }, set: { if !$0 { usingAddress = nil } })
        ) {
            Button("Use it") {
                if let name = usingAddress {
                    Task { await perform { try await model.useWiredAddress(name: name) } }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your other servers then reach your home over Wired, without Tailscale. Your home's address is who it is to other assistants: the ones you joined from home have to be joined again.")
        }
        .task(id: state?.state == .starting) {
            await read()
            while state?.state == .starting, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await read()
            }
        }
    }

    /// Whether this server has a public HTTPS address, which joining needs: it serves its relay there.
    private var isPublic: Bool { server.hasPrefix("https://") }

    @ViewBuilder private func row(_ state: WiredState) -> some View {
        switch state.state {
        case .off, .error:
            if state.state == .error {
                Text(state.error ?? "Wired stopped.").foregroundStyle(.secondary)
                Button("Turn off Wired", role: .destructive) { turningOff = true }.disabled(busy)
            }
            if let root, isPublic {
                Button("Join \(host(root))'s network", systemImage: "point.3.connected.trianglepath.dotted") {
                    Task { await join(root) }
                }
                .disabled(busy)
            }
            Button("Hold a network here", systemImage: "network") {
                Task { await act { try await model.servers.client(server).enableWired() } }
            }
            .disabled(busy)
            if root == nil, isPublic {
                Text("Or join one: hold a network on your home server first, then come back here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .unavailable:
            Text("This server's release has no Wired.").foregroundStyle(.secondary)
        case .starting:
            HStack {
                ProgressView().controlSize(.small)
                Text("Starting Wired…")
            }
        case .root, .member:
            Label(
                state.state == .root ? "Holds the network as \(state.name ?? "this server")" : "In the network as \(state.name ?? "this server")",
                systemImage: "checkmark.circle.fill"
            )
            .foregroundStyle(.green)
            ForEach(state.members.filter { $0.name != state.name }, id: \.name) { member in
                Label(member.anchor ? "\(member.name) (holds it)" : member.name, systemImage: "server.rack")
            }
            if state.state == .root, state.relays.isEmpty {
                Text("No server with a public address has joined yet: open one of them here and join this network.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let name = state.name {
                Text("Others reach it at http://nudge.\(name).wired")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                if isHome, model.homeReach != .wired {
                    Button("Use as your home's address", systemImage: "house") { usingAddress = name }
                        .disabled(busy)
                }
            }
            Button("Turn off Wired", role: .destructive) { turningOff = true }.disabled(busy)
        }
    }

    /// Whether this server is where the person's home is.
    private var isHome: Bool {
        guard let home = model.account?.server else { return false }
        return home.trimmingCharacters(in: ["/"]) == server.trimmingCharacters(in: ["/"])
    }

    private func read() async {
        do {
            show(try await model.servers.client(server).wired())
            if state?.state == .off || state?.state == .error {
                root = await model.servers.wiredRoot(except: server)
            }
        } catch NudgeError.Status(404, _) {
            state = nil
            unsupported = "This server's Nudge is older than Wired. It installs new releases itself; check for one now."
        } catch {
            problem = explain(error)
        }
    }

    /// Home lists this server's relay and this server joins with home's invite, which stays in the app.
    private func join(_ root: String) async {
        await act {
            try await model.servers.client(root).connectWired(other: try model.servers.client(server), otherUrl: server)
        }
    }

    /// Asks the server for a newer release, which it installs and restarts into when updates are
    /// automatic; then Wired is read again.
    private func checkUpdates() async {
        busy = true
        defer { busy = false }
        do {
            let updates = try await model.servers.client(server).checkUpdates()
            problem = updates.error
                ?? updates.available.map { "Installing \($0). The server restarts in a minute; come back then." }
                ?? "No newer release yet."
        } catch {
            problem = explain(error)
        }
    }

    private func act(_ action: () async throws -> WiredState) async {
        busy = true
        defer { busy = false }
        do {
            show(try await action())
        } catch {
            problem = explain(error)
        }
    }

    private func perform(_ action: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await action()
            problem = nil
        } catch {
            problem = explain(error)
        }
    }

    private func show(_ next: WiredState) {
        unsupported = nil
        state = next
        problem = nil
    }

    private func host(_ server: String) -> String {
        URL(string: server)?.host() ?? server
    }
}
