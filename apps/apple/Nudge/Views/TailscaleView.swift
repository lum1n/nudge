import Nudge
import SwiftUI

/// A server's own Tailscale (ADR 11), so it reaches a home that is only in the person's tailnet:
/// connecting opens Tailscale's page to approve it, and the section follows until it is in.
/// Shows nothing for a server that can't run it.
struct TailscaleSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let server: String
    /// Told each time the state is read, as the joining screens wait for `.connected`.
    var changed: (TailscaleState) -> Void = { _ in }
    @State private var state: TailscaleState?
    @State private var busy = false
    @State private var problem: String?
    @State private var disconnecting = false

    var body: some View {
        Group {
            if let state {
                Section {
                    row(state)
                    if let problem {
                        Text(problem).foregroundStyle(.red)
                    }
                } header: {
                    Text("Tailscale")
                } footer: {
                    Text("In your tailnet, this server reaches assistants that are only there, such as a home at a Tailscale address.")
                }
            }
        }
        .task(id: waiting) {
            await read()
            // Until someone approved it, or it gave up.
            while waiting, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await read()
            }
        }
        .alert("Disconnect from your tailnet?", isPresented: $disconnecting) {
            Button("Disconnect", role: .destructive) { Task { await act { try await model.servers.client(server).disconnectTailscale() } } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The server stops reaching assistants that are only in your tailnet.")
        }
    }

    private var waiting: Bool {
        switch state?.state {
        case .starting, .needsLogin, .needsApproval: true
        default: false
        }
    }

    @ViewBuilder private func row(_ state: TailscaleState) -> some View {
        switch state.state {
        case .off:
            connect("Connect to your tailnet")
        case .error:
            Text(state.error ?? "Tailscale stopped.").foregroundStyle(.secondary)
            connect("Try again")
        case .starting:
            HStack {
                ProgressView().controlSize(.small)
                Text("Starting Tailscale…")
            }
        case .needsLogin:
            if let url = state.authUrl.flatMap(URL.init(string:)) {
                Button("Approve it in Tailscale", systemImage: "checkmark.shield") { openURL(url) }
            }
            Text("Sign in to Tailscale and add this server to your tailnet. This page follows along.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .needsApproval:
            Text("Waiting for your tailnet's admin to approve the server.").foregroundStyle(.secondary)
        case .connected:
            Label("In your tailnet as \(state.name ?? state.addresses.first ?? "this server")", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
            Button("Disconnect", role: .destructive) { disconnecting = true }
        }
    }

    private func connect(_ title: String) -> some View {
        Button(title, systemImage: "network") {
            Task {
                await act {
                    let next = try await model.servers.client(server).connectTailscale(authKey: nil)
                    if next.state == .needsLogin, let url = next.authUrl.flatMap(URL.init(string:)) { openURL(url) }
                    return next
                }
            }
        }
        .disabled(busy)
    }

    private func read() async {
        do {
            show(try await model.servers.client(server).tailscale())
        } catch NudgeError.Status(404, _) {
            state = nil
        } catch {
            problem = explain(error)
        }
    }

    private func act(_ action: () async throws -> TailscaleState) async {
        busy = true
        defer { busy = false }
        do {
            show(try await action())
        } catch {
            problem = explain(error)
        }
    }

    private func show(_ next: TailscaleState) {
        state = next
        problem = nil
        changed(next)
    }
}

/// What the person's home lacks to join assistants on other servers, and turning federation on
/// there. Shows nothing when it lacks nothing, or while signed out.
struct HomeFederationSection: View {
    @Environment(AppModel.self) private var model
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        if let missing = model.homeProblem {
            Section {
                Text(missing.localizedDescription)
                if missing == .noFederation {
                    Button(busy ? "Turning it on…" : "Turn on federation at home", systemImage: "point.3.connected.trianglepath.dotted") {
                        Task { await turnOn() }
                    }
                    .disabled(busy)
                }
                if let problem {
                    Text(problem).foregroundStyle(.red)
                }
            } header: {
                Text("Your home first")
            } footer: {
                if missing == .noFederation, let server = model.account?.server {
                    Text("Other servers will reach your home at \(server).")
                }
            }
        }
    }

    private func turnOn() async {
        busy = true
        defer { busy = false }
        do {
            try await model.turnOnFederation()
            problem = nil
        } catch {
            problem = explain(error)
        }
    }
}
