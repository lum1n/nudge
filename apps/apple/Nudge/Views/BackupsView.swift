import Nudge
import SwiftUI

/// "5 minutes ago", in the device's language.
private func ago(_ at: Double) -> String {
    Date(timeIntervalSince1970: at / 1000).formatted(.relative(presentation: .named))
}

/// The server's backups (ADR 8), on its screen: how they go, opening where they are copied. Empty
/// on a server whose backups aren't run through its API.
struct BackupsSection: View {
    @Environment(AppModel.self) private var model
    let server: String
    @State private var state: BackupState?

    var body: some View {
        // Always one section, so the task below runs.
        Section {
            if let state {
                NavigationLink {
                    BackupsView(server: server, state: state) { self.state = $0 }
                } label: {
                    VStack(alignment: .leading) {
                        Label("Backups", systemImage: "externaldrive.badge.timemachine")
                        Text(summary(state)).font(.caption)
                            .foregroundStyle(state.lastError == nil ? Color.secondary : .red)
                    }
                }
            }
        }
        .task(id: server) {
            // A server without them through its API answers 404: the section stays empty.
            state = try? await model.servers.client(server).backups()
        }
    }

    private func summary(_ state: BackupState) -> String {
        guard state.on else { return String(localized: "Off") }
        if state.lastError != nil { return String(localized: "The last upload failed") }
        let place: String
        switch state.remote {
        case .s3(_, let bucket, _, _, _): place = String(localized: "Copied to \(bucket)")
        case .webDav(let url): place = String(localized: "Copied to \(URL(string: url)?.host() ?? url)")
        case nil: place = String(localized: "On the server only")
        }
        return state.lastBackupAt.map { "\(place) · \(ago($0))" } ?? place
    }
}

/// Where the server's backups are copied off it: an S3-compatible bucket or a WebDAV folder. They
/// are encrypted before they leave, so the bucket or folder only holds ciphertext.
private struct BackupsView: View {
    @Environment(AppModel.self) private var model
    let server: String
    @State var state: BackupState
    let changed: (BackupState) -> Void

    private enum Kind: Hashable { case s3, webDav }
    @State private var kind = Kind.s3
    @State private var endpoint = ""
    @State private var bucket = ""
    @State private var region = ""
    @State private var prefix = ""
    @State private var url = ""
    @State private var user = ""
    @State private var secret = ""
    @State private var busy: String?
    @State private var problem: String?
    @State private var note: String?

    var body: some View {
        Form {
            Section {
                Text(status)
                if let error = state.lastError {
                    Text(state.lastErrorAt.map { String(localized: "The last upload failed \(ago($0)): \(error)") }
                        ?? String(localized: "The last upload failed: \(error)"))
                        .foregroundStyle(.red)
                }
            } footer: {
                Text("The whole server, encrypted with its backup key. A copy on another machine survives the server's disk: an S3-compatible bucket (AWS, Backblaze B2, Cloudflare R2, MinIO) or a WebDAV folder (Nextcloud, a NAS). Only encrypted files leave the server.")
            }
            Section {
                Picker("Copy each backup to", selection: $kind) {
                    Text("An S3 bucket").tag(Kind.s3)
                    Text("A WebDAV folder").tag(Kind.webDav)
                }
                if kind == .s3 {
                    TextField("Endpoint", text: $endpoint, prompt: Text(verbatim: "https://s3.eu-north-1.amazonaws.com"))
                        .addressField()
                    TextField("Bucket", text: $bucket).addressField()
                    TextField("Region", text: $region, prompt: Text("Optional: us-east-1 unless the endpoint says"))
                        .addressField()
                    TextField("Folder in the bucket", text: $prefix, prompt: Text(verbatim: "nudge/")).addressField()
                    TextField("Access key id", text: $user).addressField()
                    SecureField("Secret access key", text: $secret, prompt: keptSecret ? Text("Kept; type to change it") : nil)
                } else {
                    TextField("Folder address", text: $url, prompt: Text(verbatim: "https://cloud.example/remote.php/dav/files/me/nudge/"))
                        .addressField()
                    TextField("User name", text: $user).addressField()
                    SecureField("Password", text: $secret, prompt: keptSecret ? Text("Kept; type to change it") : Text("An app password, if the service has them"))
                }
            } footer: {
                if state.remoteUserFromEnv {
                    Text("The server takes its credentials from NUDGE_BACKUP_REMOTE_USER and NUDGE_BACKUP_REMOTE_SECRET, which win over what is set here.")
                }
            }
            Section {
                Button(busy == "save" ? "Checking…" : "Check and save") {
                    run("save") {
                        saved(try await $0.setBackupRemote(target: target, user: user.trimmed.nilIfEmpty, secret: secret.nilIfEmpty))
                        return String(localized: "Saved: the server wrote a test file there and deleted it again.")
                    }
                }
                if state.remote != nil {
                    Button("Stop copying", role: .destructive) {
                        run("remove") {
                            saved(try await $0.removeBackupRemote())
                            return String(localized: "Backups stay on the server only. What was copied there is left there.")
                        }
                    }
                }
                if state.on {
                    Button(busy == "now" ? "Backing up…" : "Back up now", systemImage: "arrow.up.doc") {
                        let copied = state.remote != nil
                        run("now") { client in
                            let made = try await client.backUpNow()
                            if let next = try? await client.backups() { saved(next) }
                            if let error = made.uploadError { throw BackupUploadFailed(message: error) }
                            return copied ? String(localized: "Made \(made.file) and uploaded it.") : String(localized: "Made \(made.file).")
                        }
                    }
                }
                if let problem { Text(problem).foregroundStyle(.red) }
                if let note { Text(note).foregroundStyle(.green) }
            }
            .disabled(busy != nil)
        }
        .formStyle(.grouped)
        .navigationTitle("Backups")
        .onAppear { edit(state) }
    }

    private var status: String {
        guard state.on else {
            return String(localized: "Off: this server makes no backups of its own. Setting a copy below turns them on, daily.")
        }
        let keep = Int(state.keep), dir = state.dir ?? ""
        var lines = [
            state.everyHours == 24
                ? String(localized: "Every day, the last \(keep) kept, in \(dir).")
                : String(localized: "Every \(Int(state.everyHours)) hours, the last \(keep) kept, in \(dir)."),
            state.lastBackupAt.map { String(localized: "The newest was made \(ago($0)).") } ?? String(localized: "None made yet."),
        ]
        if state.remote != nil {
            lines.append(state.lastUploadAt.map { String(localized: "Last uploaded \(ago($0)).") } ?? String(localized: "None uploaded yet."))
        }
        return lines.joined(separator: " ")
    }

    /// Whether the server keeps a secret for the kind of target being edited.
    private var keptSecret: Bool {
        switch state.remote {
        case .s3: state.remoteUser != nil && kind == .s3
        case .webDav: state.remoteUser != nil && kind == .webDav
        case nil: false
        }
    }

    /// What the server is sent: empty fields left out, so their defaults apply.
    private var target: BackupTarget {
        kind == .s3
            ? .s3(endpoint: endpoint.trimmed, bucket: bucket.trimmed, region: region.trimmed.nilIfEmpty, prefix: prefix.trimmed.nilIfEmpty, pathStyle: nil)
            : .webDav(url: url.trimmed)
    }

    private func edit(_ state: BackupState) {
        switch state.remote {
        case let .s3(endpoint, bucket, region, prefix, _):
            kind = .s3
            self.endpoint = endpoint
            self.bucket = bucket
            self.region = region ?? ""
            self.prefix = prefix ?? ""
        case let .webDav(url):
            kind = .webDav
            self.url = url
        case nil: break
        }
        user = state.remoteUser ?? ""
        secret = ""
    }

    private func saved(_ next: BackupState) {
        state = next
        changed(next)
        edit(next)
    }

    private func run(_ what: String, _ work: @escaping @MainActor (ServerClient) async throws -> String) {
        busy = what
        problem = nil
        note = nil
        Task {
            defer { busy = nil }
            do {
                note = try await work(model.servers.client(server))
            } catch {
                problem = explain(error)
            }
        }
    }
}

/// A backup made, whose upload failed: why.
private struct BackupUploadFailed: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private extension View {
    /// A field for an address, key or name: typed as is.
    func addressField() -> some View {
        autocorrectionDisabled()
        #if os(iOS)
            .textInputAutocapitalization(.never)
        #endif
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
