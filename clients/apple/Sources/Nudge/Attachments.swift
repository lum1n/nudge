// Attachments (ADR 24): photos scaled down before they go, the composer's uploads, and the bytes
// of those sent, kept in memory while the app runs.
import Foundation
import Observation
#if canImport(ImageIO)
import ImageIO
import UniformTypeIdentifiers
#endif

/// Scaling photos down before uploading, to `attachmentImageMaxSide()` on the long side, as
/// providers would anyway.
public enum ImageScaling {
    /// The image types the server takes as images; anything else is a file.
    public static let imageTypes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]

    /// The size to draw an image of `width` × `height` at, or nil to send it as it is.
    public static func targetSize(width: Int, height: Int, maxSide: Int = Int(attachmentImageMaxSide())) -> (width: Int, height: Int)? {
        let long = max(width, height)
        guard long > maxSide, long > 0 else { return nil }
        let scale = Double(maxSide) / Double(long)
        return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
    }

    /// A file name with its extension swapped for `.jpg`.
    public static func jpegName(_ name: String) -> String {
        let base = (name as NSString).deletingPathExtension
        return (base.isEmpty ? "image" : base) + ".jpg"
    }

    #if canImport(ImageIO)
    /// A photo ready to upload: as it is when it is a GIF, or an image type providers take that
    /// is small enough; otherwise drawn at most `maxSide` on the long side, upright, as a JPEG,
    /// which also makes HEIC from the camera one the model can see. Nil for data that isn't an
    /// image ImageIO reads.
    public static func prepare(
        _ data: Data, name: String, mime: String, maxSide: Int = Int(attachmentImageMaxSide())
    ) -> (data: Data, name: String, mime: String)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        if mime == "image/gif" { return (data, name, mime) }
        let rotated = (properties[kCGImagePropertyOrientation] as? Int ?? 1) != 1
        if imageTypes.contains(mime), !rotated, targetSize(width: width, height: height, maxSide: maxSide) == nil {
            return (data, name, mime)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(maxSide, max(width, height)),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return (out as Data, jpegName(name), "image/jpeg")
    }
    #endif
}

/// A size for people: `240 KB`, `1.2 MB`.
public func sizeLabel(_ bytes: UInt64) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded())) KB" }
    return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
}

/// One file in the composer: uploading, uploaded and ready to send, or refused.
public struct AttachmentDraft: Identifiable, Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case uploading
        case ready(Attachment)
        case failed(String)
    }

    public let id: UUID
    public let name: String
    /// Whether it is a picture, as far as the composer knows before the server says.
    public let image: Bool
    public var state: State
}

/// The composer's attachments in one room: each is uploaded as soon as it is picked, so sending
/// only names their ids; taking one off before sending deletes its upload. `take()` hands over
/// those ready when the message goes.
@MainActor @Observable
public final class AttachmentDrafts {
    public private(set) var drafts: [AttachmentDraft] = []
    @ObservationIgnored private let upload: @MainActor (_ name: String, _ mime: String, _ data: Data) async throws -> Attachment
    @ObservationIgnored private let discard: @MainActor (_ id: String) async throws -> Void

    public init(
        upload: @escaping @MainActor (_ name: String, _ mime: String, _ data: Data) async throws -> Attachment,
        discard: @escaping @MainActor (_ id: String) async throws -> Void
    ) {
        self.upload = upload
        self.discard = discard
    }

    /// For a room of `client`.
    public convenience init(client: NudgeClient, room: String) {
        self.init(
            upload: { name, mime, data in
                try await client.uploadAttachment(room: room, name: name, mime: mime, bytes: data)
            },
            discard: { id in try await client.removeAttachment(room: room, id: id) })
    }

    /// Whether a message would go with nothing but what is ready: none still uploading.
    public var uploading: Bool { drafts.contains { $0.state == .uploading } }
    /// Those ready to send.
    public var ready: [Attachment] {
        drafts.compactMap { if case .ready(let attachment) = $0.state { attachment } else { nil } }
    }
    public var hasImages: Bool { drafts.contains(where: \.image) }

    /// Uploads a picked file; it shows as uploading, then ready or with why it was refused.
    public func add(name: String, mime: String, data: Data) async {
        let id = UUID()
        let image = mime.hasPrefix("image/")
        if drafts.count >= Int(attachmentsPerMessage()) {
            drafts.append(AttachmentDraft(id: id, name: name, image: image, state: .failed("At most \(attachmentsPerMessage()) files per message")))
            return
        }
        if UInt64(data.count) > attachmentMaxBytes() {
            drafts.append(AttachmentDraft(id: id, name: name, image: image, state: .failed("Larger than \(sizeLabel(attachmentMaxBytes()))")))
            return
        }
        drafts.append(AttachmentDraft(id: id, name: name, image: image, state: .uploading))
        let state: AttachmentDraft.State
        do {
            let attachment = try await upload(name, mime, data)
            // Taken off while it was on its way: the upload goes too.
            guard drafts.contains(where: { $0.id == id }) else {
                try? await discard(attachment.id)
                return
            }
            state = .ready(attachment)
        } catch {
            if case .Status(_, let detail) = error as? NudgeError {
                state = .failed(detail)
            } else {
                state = .failed(error.localizedDescription)
            }
        }
        if let index = drafts.firstIndex(where: { $0.id == id }) { drafts[index].state = state }
    }

    /// Takes a file off the composer, deleting its upload.
    public func remove(_ id: UUID) {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return }
        let draft = drafts.remove(at: index)
        if case .ready(let attachment) = draft.state {
            Task { try? await discard(attachment.id) }
        }
    }

    /// The uploads to send with a message; the composer is empty of them after.
    public func take() -> [Attachment] {
        let ready = ready
        drafts.removeAll { if case .ready = $0.state { true } else { false } }
        return ready
    }
}

/// The bytes of attachments seen, kept in memory while the app runs, fetched once each.
@MainActor
public final class AttachmentStore {
    public static let shared = AttachmentStore()
    private var bytes: [String: Data] = [:]
    private var loading: [String: Task<Data, Error>] = [:]

    public init() {}

    /// An attachment's bytes; throws `NudgeError.Status` 410 for a removed one.
    public func data(_ client: NudgeClient, room: String, id: String) async throws -> Data {
        let key = "\(ObjectIdentifier(client).hashValue)/\(room)/\(id)"
        if let data = bytes[key] { return data }
        if let task = loading[key] { return try await task.value }
        let task = Task { try await client.attachment(room: room, id: id) }
        loading[key] = task
        defer { loading[key] = nil }
        let data = try await task.value
        bytes[key] = data
        return data
    }
}

extension NudgeError {
    /// The attachment was removed: its uploader or an admin took it away.
    public var isGone: Bool {
        if case .Status(let status, _) = self { status == 410 } else { false }
    }
}
