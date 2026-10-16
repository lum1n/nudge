import Nudge
import SwiftUI
import UniformTypeIdentifiers

/// The room's documents: receipts, warranties, contracts and letters. Their text is read on the
/// host, so the assistant can search them; the files are stored encrypted there.
struct DocumentsView: View {
    let client: NudgeClient
    let roomId: String
    @State private var documents: ObservedDocuments?
    @State private var openingError: String?
    @State private var importing = false
    @State private var uploading: String?
    @State private var problem: String?
    @State private var query = ""
    @State private var download: DownloadedDocument?
    @State private var deleting: DocumentInfo?

    var body: some View {
        content
            .navigationTitle("Documents")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    if let uploading {
                        ProgressView().help("Uploading \(uploading)…")
                    } else {
                        Button("Upload", systemImage: "square.and.arrow.up") { importing = true }
                            .disabled(documents?.value?.documents == nil)
                    }
                }
            }
            .searchable(text: $query, prompt: "Find by name")
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                Task { await upload(result) }
            }
            .fileExporter(
                isPresented: Binding(get: { download != nil }, set: { if !$0 { download = nil } }),
                document: download,
                contentType: download.flatMap { UTType(mimeType: $0.file.mime) } ?? .data,
                defaultFilename: download?.file.name
            ) { result in
                if case .failure(let error) = result { problem = error.localizedDescription }
            }
            .confirmationDialog(
                "Delete \(deleting?.name ?? "")?",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
            ) {
                Button("Delete", role: .destructive) {
                    if let deleting { documents?.remove(deleting) }
                }
            } message: {
                Text("It goes for everyone in the room, and the assistant can't read it any more.")
            }
            .onAppear {
                guard documents == nil else { return }
                do {
                    documents = try client.observeDocuments(roomId)
                } catch {
                    openingError = explain(error)
                }
            }
            .onDisappear {
                documents?.close()
                documents = nil
            }
    }

    @ViewBuilder private var content: some View {
        let state = documents?.value
        if let openingError {
            ContentUnavailableView("Can't open the documents", systemImage: "exclamationmark.triangle", description: Text(openingError))
        } else if case .closed(let code, _)? = state?.status, code == 4404 {
            ContentUnavailableView(
                "No documents here", systemImage: "doc.text",
                description: Text("Turn on the documents extension for this room under Room."))
        } else if let all = state?.documents {
            Form {
                Section {
                    if let error = problem ?? state?.error {
                        Text(error).foregroundStyle(.red)
                    }
                    if all.isEmpty {
                        Text("No documents yet.").foregroundStyle(.secondary)
                    }
                    ForEach(shown(all)) { document in
                        Button {
                            Task { await save(document) }
                        } label: {
                            DocumentRow(document: document)
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button("Delete", role: .destructive) { deleting = document }
                        }
                        .contextMenu {
                            Button("Download", systemImage: "arrow.down.circle") { Task { await save(document) } }
                            Button("Delete", systemImage: "trash", role: .destructive) { deleting = document }
                        }
                    }
                } footer: {
                    Text("Their text is read on the server, so the assistant can search them; the files are stored encrypted. Images are kept but not read.")
                }
            }
            .formStyle(.grouped)
        } else {
            ProgressView()
        }
    }

    private func shown(_ all: [DocumentInfo]) -> [DocumentInfo] {
        let words = query.lowercased().split(separator: " ")
        return all.filter { document in
            words.allSatisfy { document.name.lowercased().contains($0) || document.addedBy.lowercased().contains($0) }
        }
    }

    private func upload(_ result: Result<[URL], Error>) async {
        guard let documents else { return }
        do {
            for url in try result.get() {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                uploading = url.lastPathComponent
                let data = try Data(contentsOf: url)
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                try await documents.upload(name: url.lastPathComponent, mime: mime, data: data)
            }
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
        uploading = nil
    }

    private func save(_ document: DocumentInfo) async {
        do {
            guard let file = try await documents?.download(document) else { return }
            download = DownloadedDocument(file: file)
        } catch {
            problem = error.localizedDescription
        }
    }
}

private struct DocumentRow: View {
    let document: DocumentInfo

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: document.mime.hasPrefix("image/") ? "photo" : "doc.text")
                .foregroundStyle(.tint)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(document.name).lineLimit(2)
                Text(details).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    private var details: String {
        [
            document.pages.map { "\($0) pages" },
            ByteCountFormatter.string(fromByteCount: Int64(document.size), countStyle: .file),
            document.addedBy,
            date(document.addedAt).formatted(date: .abbreviated, time: .omitted),
            document.note,
        ].compactMap(\.self).joined(separator: " · ")
    }
}

/// A downloaded document, for saving where the user picks.
struct DownloadedDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    var file: DocumentFile

    init(file: DocumentFile) { self.file = file }

    init(configuration: ReadConfiguration) throws { throw CocoaError(.featureUnsupported) }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        let wrapper = FileWrapper(regularFileWithContents: file.data)
        wrapper.preferredFilename = file.name
        return wrapper
    }
}
