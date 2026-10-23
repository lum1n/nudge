import Nudge
import SwiftUI

/// The server's own map (ADR 17): the region it downloads for places and routes, and how far it is.
struct MapsSection: View {
    @Environment(AppModel.self) private var model
    let server: String
    @State private var status: GeoStatus?
    @State private var problem: String?

    var body: some View {
        // Always one section, so the task below runs.
        Section {
            if let status {
                Picker("Region", selection: Binding(
                    get: { status.region ?? "" },
                    set: { code in Task { await pick(code.isEmpty ? nil : code) } }
                )) {
                    Text("None").tag("")
                    ForEach(status.regions, id: \.code) { region in
                        Text(region.name).tag(region.code)
                    }
                }
                Text(note(status)).font(.caption).foregroundStyle(status.state == .failed ? .red : .secondary)
            }
            if let problem {
                Text(problem).foregroundStyle(.red)
            }
        } header: {
            Text("Maps")
        } footer: {
            Text("Addresses, places and routes for reminders when someone gets somewhere. The server downloads the map of one region and keeps it, so where people go stays here. It takes a few GB of disk.")
        }
        .task(id: server) { await follow() }
    }

    private func note(_ status: GeoStatus) -> String {
        let region = status.regions.first { $0.code == status.region }?.name ?? ""
        switch status.state {
        case .off: return "Off. Pick a region for places and routes."
        case .downloading, .importing:
            return "Getting \(status.step ?? region) ready" + (status.progress.map { " (\(Int($0 * 100))%)" } ?? "…")
        case .ready: return "\(region), kept up to date every month"
        case .failed: return status.error ?? "Failed"
        }
    }

    private func pick(_ region: String?) async {
        do {
            status = try await model.servers.client(server).setGeo(region: region)
            problem = nil
            await follow()
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Reads the map's state, and again every few seconds while it downloads.
    private func follow() async {
        repeat {
            // Older servers have no map: the section stays empty.
            guard let next = try? await model.servers.client(server).geo() else { return }
            status = next
            guard next.state == .downloading || next.state == .importing else { return }
            try? await Task.sleep(for: .seconds(3))
        } while !Task.isCancelled
    }
}
