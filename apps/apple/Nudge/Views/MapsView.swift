import Nudge
import SwiftUI

/// The server's own map (ADR 17): the regions it holds, anywhere in the world, the ones it fetches
/// because someone was there, and the disk they may take.
struct MapsSection: View {
    @Environment(AppModel.self) private var model
    let server: String
    @State private var status: GeoStatus?
    @State private var problem: String?
    @State private var limit: Double = 20

    var body: some View {
        // Always one section, so the task below runs.
        Section {
            if let status {
                Toggle(isOn: Binding(
                    get: { status.follow },
                    set: { on in Task { await change { try await $0.configureGeo(regions: nil, follow: on, limitGb: nil) } } }
                )) {
                    VStack(alignment: .leading) {
                        Text("Follow people")
                        Text("Fetch the region someone's phone says they are in, anywhere in the world.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Stepper(value: $limit, in: 5...200, step: 5) {
                    Text("At most \(Int(limit)) GB on disk (\(gigabytes(status.usedBytes)) now)")
                } onEditingChanged: { editing in
                    if !editing {
                        Task { await change { try await $0.configureGeo(regions: nil, follow: nil, limitGb: limit) } }
                    }
                }
                ForEach(status.regions, id: \.id) { region in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(region.name)
                            Text(note(region)).font(.caption)
                                .foregroundStyle(region.state == .failed ? .red : .secondary)
                        }
                        Spacer()
                        Button(region.byOwner ? "Remove" : "Keep") {
                            var owners = status.regions.filter { $0.byOwner && $0.id != region.id }.map(\.id)
                            // A region fetched for someone becomes one an owner keeps, or goes.
                            if !region.byOwner { owners.append(region.id) }
                            Task { await change { try await $0.configureGeo(regions: owners, follow: nil, limitGb: nil) } }
                        }
                    }
                }
                NavigationLink {
                    AddRegionView(server: server, have: Set(status.regions.map(\.id))) { region in
                        let owners = status.regions.filter(\.byOwner).map(\.id) + [region.id]
                        Task { await change { try await $0.configureGeo(regions: owners, follow: nil, limitGb: nil) } }
                    }
                } label: {
                    Label("Add a region", systemImage: "plus")
                }
            }
            if let problem {
                Text(problem).foregroundStyle(.red)
            }
        } header: {
            Text("Maps")
        } footer: {
            Text("Addresses, places and routes for reminders when someone gets somewhere, from OpenStreetMap. The server downloads the map of each region and keeps it, so where people go stays here.")
        }
        .task(id: server) { await follow() }
    }

    private func gigabytes(_ bytes: Double) -> String {
        String(format: "%.1f GB", bytes / Double(1 << 30))
    }

    private func note(_ region: GeoRegionStatus) -> String {
        switch region.state {
        case .waiting: return "Waiting"
        case .downloading, .importing:
            return "Getting \(region.step ?? "it") ready" + (region.progress.map { " (\(Int($0 * 100))%)" } ?? "…")
        case .ready:
            return (region.bytes.map { gigabytes($0) + ", " } ?? "")
                + (region.byOwner ? "kept" : "because someone was there; dropped first to make room")
        case .failed: return region.error ?? "Failed"
        }
    }

    private func change(_ work: (ServerClient) async throws -> GeoStatus) async {
        do {
            status = try await work(model.servers.client(server))
            limit = status?.limitGb ?? limit
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Reads the map's state, often while a region is on its way.
    private func follow() async {
        repeat {
            // Older servers have no map: the section stays empty.
            guard let next = try? await model.servers.client(server).geo() else { return }
            status = next
            limit = next.limitGb
            try? await Task.sleep(for: .seconds(next.state == .working ? 3 : 30))
        } while !Task.isCancelled
    }
}

/// Every region in the world, to search by name: countries, and states and provinces of large ones.
private struct AddRegionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let server: String
    let have: Set<String>
    let pick: (GeoRegion) -> Void
    @State private var regions: [GeoRegion]?
    @State private var problem: String?
    @State private var query = ""

    var body: some View {
        List {
            if let problem {
                Text(problem).foregroundStyle(.red)
            } else if let regions {
                let names = Dictionary(regions.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
                ForEach(shown(regions), id: \.id) { region in
                    Button {
                        pick(region)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading) {
                            Text(region.name)
                            if let parent = region.parent.flatMap({ names[$0] }) {
                                Text(parent).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } else {
                ProgressView()
            }
        }
        .searchable(text: $query, prompt: "Country, state or province")
        .navigationTitle("Add a region")
        .task {
            do {
                regions = try await model.servers.client(server).geoRegions()
            } catch {
                problem = error.localizedDescription
            }
        }
    }

    private func shown(_ regions: [GeoRegion]) -> [GeoRegion] {
        let text = query.trimmingCharacters(in: .whitespaces)
        return regions
            .filter { $0.parent != nil && !have.contains($0.id) && (text.isEmpty || $0.name.localizedCaseInsensitiveContains(text)) }
            .sorted { $0.name < $1.name }
    }
}
