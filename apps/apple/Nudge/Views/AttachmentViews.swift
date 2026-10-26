import Nudge
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Where a room's attachments come from: their bytes, fetched with the token and kept in memory.
struct AttachmentSource {
    let client: NudgeClient
    let room: String

    @MainActor func data(_ id: String) async throws -> Data {
        try await AttachmentStore.shared.data(client, room: room, id: id)
    }
}

extension EnvironmentValues {
    /// The room's attachments, for the messages that show them.
    @Entry var attachmentSource: AttachmentSource?
}

/// The composer's paper clip: photos, scaled down, or any file, each uploaded as it is picked.
struct AttachButton: View {
    let drafts: AttachmentDrafts
    @State private var choosingPhotos = false
    @State private var choosingFiles = false
    @State private var photos: [PhotosPickerItem] = []

    var body: some View {
        Menu {
            Button("Photos", systemImage: "photo.on.rectangle") { choosingPhotos = true }
            Button("Files", systemImage: "doc") { choosingFiles = true }
        } label: {
            Image(systemName: "paperclip").frame(width: 24, height: 24)
        }
        .menuIndicator(.hidden)
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .controlSize(.large)
        .accessibilityLabel("Attach photos or files")
        .photosPicker(
            isPresented: $choosingPhotos, selection: $photos,
            maxSelectionCount: Int(attachmentsPerMessage()), matching: .images)
        .onChange(of: photos) { _, picked in
            guard !picked.isEmpty else { return }
            photos = []
            for item in picked { Task { await addPhoto(item) } }
        }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls { Task { await addFile(url) } }
        }
    }

    private func addPhoto(_ item: PhotosPickerItem) async {
        let type = item.supportedContentTypes.first ?? .jpeg
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let name = "Photo.\(type.preferredFilenameExtension ?? "jpg")"
        await add(name: name, mime: type.preferredMIMEType ?? "image/jpeg", data: data)
    }

    private func addFile(_ url: URL) async {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        await add(name: url.lastPathComponent, mime: mime, data: data)
    }

    /// Scales a picture down first; anything else goes as it is.
    private func add(name: String, mime: String, data: Data) async {
        if mime.hasPrefix("image/"), let scaled = ImageScaling.prepare(data, name: name, mime: mime) {
            await drafts.add(name: scaled.name, mime: scaled.mime, data: scaled.data)
        } else {
            await drafts.add(name: name, mime: mime, data: data)
        }
    }
}

/// The files picked for the next message, each uploading, ready or refused, with a way to take it
/// off; and whether the model will see the pictures among them.
struct AttachmentChips: View {
    let drafts: AttachmentDrafts
    let imagesToModel: Bool

    var body: some View {
        if !drafts.drafts.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(drafts.drafts) { draft in chip(draft) }
                    }
                }
                .scrollIndicators(.hidden)
                if drafts.hasImages {
                    Text(imagesToModel
                        ? "The model sees these images as they are."
                        : "The model gets only these images' names. Turn on Send images to the model in the room's details to let it see them.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func chip(_ draft: AttachmentDraft) -> some View {
        HStack(spacing: 6) {
            Image(systemName: draft.image ? "photo" : "doc")
            Text(draft.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160)
            switch draft.state {
            case .uploading:
                ProgressView().controlSize(.mini).accessibilityLabel("Uploading")
            case .ready:
                EmptyView()
            case .failed(let why):
                Image(systemName: "exclamationmark.circle").foregroundStyle(.red).help(why)
                    .accessibilityLabel(why)
            }
            Button {
                drafts.remove(draft.id)
            } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(draft.name)")
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .glassEffect(draft.state.failed ? .regular.tint(.red.opacity(0.3)) : .regular, in: .capsule)
    }
}

extension AttachmentDraft.State {
    var failed: Bool { if case .failed = self { true } else { false } }
}

/// A message's attachments: pictures as thumbnails, other files to save or share.
struct MessageAttachments: View {
    let attachments: [Attachment]
    let mine: Bool

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
            ForEach(attachments, id: \.id) { attachment in
                switch attachment.kind {
                case .image: ImageAttachment(attachment: attachment)
                case .file: FileAttachment(attachment: attachment)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .padding(mine ? .leading : .trailing, 40)
    }
}

/// How the bytes of one attachment came along.
private enum Loaded: Equatable {
    case loading
    case loaded(Data)
    /// Removed: the name stays, so people know there was one.
    case gone
    case failed(String)
}

@MainActor private func load(_ source: AttachmentSource?, _ attachment: Attachment) async -> Loaded {
    guard let source else { return .failed("No room") }
    do {
        return .loaded(try await source.data(attachment.id))
    } catch let error as NudgeError where error.isGone {
        return .gone
    } catch {
        return .failed(explain(error))
    }
}

struct ImageAttachment: View {
    let attachment: Attachment
    @Environment(\.attachmentSource) private var source
    @State private var loaded = Loaded.loading
    @State private var enlarged = false

    var body: some View {
        Group {
            switch loaded {
            case .loading:
                RoundedRectangle(cornerRadius: 16).fill(.fill.tertiary).frame(width: 160, height: 120)
                    .overlay { ProgressView() }
            case .loaded(let data):
                if let image = picture(data) {
                    Button { enlarged = true } label: {
                        image.resizable().scaledToFit()
                            .frame(maxWidth: 240, maxHeight: 240)
                            .clipShape(.rect(cornerRadius: 16))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(attachment.name)
                    .sheet(isPresented: $enlarged) {
                        PanelSheet {
                            image.resizable().scaledToFit().padding()
                                .navigationTitle(attachment.name)
                                .toolbar {
                                    ToolbarItem {
                                        ShareLink(item: image, preview: SharePreview(attachment.name, image: image))
                                    }
                                }
                        }
                    }
                } else {
                    FileAttachment(attachment: attachment)
                }
            case .gone:
                RemovedAttachment(name: attachment.name)
            case .failed(let why):
                Label(attachment.name, systemImage: "exclamationmark.triangle").font(.caption).help(why)
            }
        }
        .task(id: attachment.id) { loaded = await load(source, attachment) }
    }

    private func picture(_ data: Data) -> Image? {
        #if canImport(UIKit)
        UIImage(data: data).map { Image(uiImage: $0) }
        #else
        NSImage(data: data).map { Image(nsImage: $0) }
        #endif
    }
}

struct FileAttachment: View {
    let attachment: Attachment
    @Environment(\.attachmentSource) private var source
    @State private var saving: AttachmentFile?
    @State private var gone = false
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        if gone {
            RemovedAttachment(name: attachment.name)
        } else {
            Button {
                Task { await save() }
            } label: {
                HStack(spacing: 8) {
                    if busy { ProgressView().controlSize(.small) } else { Image(systemName: "doc") }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(attachment.name).lineLimit(1).truncationMode(.middle)
                        Text(sizeLabel(attachment.size)).font(.caption2).foregroundStyle(.secondary)
                    }
                    Image(systemName: "arrow.down.circle").foregroundStyle(.secondary)
                }
                .font(.callout)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .glassEffect(in: .rect(cornerRadius: 16))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Download \(attachment.name)")
            .help(problem ?? "")
            .fileExporter(
                isPresented: Binding(get: { saving != nil }, set: { if !$0 { saving = nil } }),
                document: saving,
                contentType: UTType(mimeType: attachment.mime) ?? .data,
                defaultFilename: attachment.name
            ) { result in
                if case .failure(let error) = result { problem = error.localizedDescription }
            }
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        switch await load(source, attachment) {
        case .loaded(let data): saving = AttachmentFile(name: attachment.name, data: data)
        case .gone: gone = true
        case .failed(let why): problem = why
        case .loading: break
        }
    }
}

/// One that can't be shown any more: its uploader or an admin removed it.
struct RemovedAttachment: View {
    let name: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "paperclip")
            Text(name).strikethrough()
            Text("(removed)")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

/// An attachment's bytes, to save where the person chooses.
struct AttachmentFile: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    var name: String
    var data: Data

    init(name: String, data: Data) {
        self.name = name
        self.data = data
    }

    init(configuration: ReadConfiguration) throws { throw CocoaError(.featureUnsupported) }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        let wrapper = FileWrapper(regularFileWithContents: data)
        wrapper.preferredFilename = name
        return wrapper
    }
}

/// What stands for a message of files alone, where its text would be.
func attachmentsLine(_ attachments: [Attachment]) -> String {
    "📎 " + attachments.map(\.name).joined(separator: ", ")
}
