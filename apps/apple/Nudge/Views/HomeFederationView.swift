import Nudge
import SwiftUI

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
