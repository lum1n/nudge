// A room's documents, over the documents extension's panel socket: the list as it changes,
// uploads, downloads and deletions. Files cross the socket as base64. The socket reconnects on its
// own and the extension sends the list again each time.
import Foundation
import NudgeFFI
import Observation

/// A document in a room: `size` in bytes, `chars` of text read from it, `pages` for a PDF, `note`
/// when its text couldn't be read (such as an image).
public struct DocumentInfo: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var mime: String
    public var size: Int
    public var pages: Int?
    public var chars: Int
    public var note: String?
    public var addedBy: String
    /// Milliseconds since the epoch.
    public var addedAt: Double
}

/// A downloaded document's bytes.
public struct DocumentFile: Equatable, Sendable {
    public var name: String
    public var mime: String
    public var data: Data
}

/// What an ``ObservedDocuments`` shows: the socket's status, the documents (newest first) once
/// they came, and the last deletion the extension refused.
public struct DocumentsState: Equatable, Sendable {
    public var status: PanelStatus = .connecting
    public var documents: [DocumentInfo]?
    public var error: String?
}

/// A room's documents, kept current; change them with the methods here. `close()` when done.
@MainActor
public final class ObservedDocuments: Observed<DocumentsState> {
    @ObservationIgnored fileprivate var panel: Panel?
    @ObservationIgnored fileprivate let requests = Requests()

    /// Uploads a file; its text is read on the host. Returns the new document's id, or throws
    /// ``PanelRefusal``, such as for a file that is too large or here already.
    @discardableResult
    public func upload(name: String, mime: String, data: Data) async throws -> String {
        let answer = try await requests.request(
            panel, "upload",
            ["name": .string(name), "mime": .string(mime), "data": .string(data.base64EncodedString())])
        return answer["id"]?.string ?? ""
    }

    /// The document's file, as it was uploaded; throws ``PanelRefusal``.
    public func download(_ document: DocumentInfo) async throws -> DocumentFile {
        let answer = try await requests.request(panel, "download", ["id": .string(document.id)])
        return DocumentFile(
            name: answer["name"]?.string ?? document.name, mime: answer["mime"]?.string ?? document.mime,
            data: Data(base64Encoded: answer["data"]?.string ?? "") ?? Data())
    }

    public func remove(_ document: DocumentInfo) { panel?.input("remove", ["id": .string(document.id)]) }

    override public func close() {
        panel?.disconnect()
        panel = nil
        super.close()
    }
}

private final class DocumentsRelay: PanelListener, @unchecked Sendable {
    let relay: Relay<DocumentsState>
    let requests: Requests
    // Calls come one at a time, in order, so the state can be kept here.
    private var state = DocumentsState()
    init(_ relay: Relay<DocumentsState>, _ requests: Requests) {
        self.relay = relay
        self.requests = requests
    }

    func onStatus(status: PanelStatus) {
        requests.status(status)
        state.status = status
        relay.deliver(state)
    }

    func onFrame(json: String) {
        guard let frame = JSONValue(json: json), !requests.answer(frame) else { return }
        switch frame["type"]?.string {
        case "documents":
            guard let documents = frame["documents"]?.decode([DocumentInfo].self) else { return }
            state.documents = documents
        case "ok": state.error = nil
        case "error": state.error = frame["message"]?.string
        default: return
        }
        relay.deliver(state)
    }
}

extension NudgeClient {
    /// A room's documents; the room needs the documents extension on, or the state closes with 4404.
    @MainActor
    public func observeDocuments(_ room: String) throws -> ObservedDocuments {
        let observed = ObservedDocuments()
        let listener = DocumentsRelay(Relay(observed), observed.requests)
        let panel = try openPanel(room: room, extension: "documents", listener: listener)
        observed.panel = panel
        observed.stop = { panel.disconnect() }
        return observed
    }
}
