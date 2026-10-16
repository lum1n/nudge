// What the typed panels share: JSON values, inputs sent with a `ref`, and the frames that answer
// them.
import Foundation
import NudgeFFI

/// Any JSON value: an extension's frames, and settings and their schemas.
public enum JSONValue: Codable, Equatable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// Reads JSON text; nil for text that isn't JSON.
    public init?(json: String) {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) else { return nil }
        self = value
    }

    /// As JSON text, with object keys sorted.
    public var json: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "null"
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { object[key] } else { nil }
    }

    public var string: String? { if case .string(let value) = self { value } else { nil } }
    public var number: Double? { if case .number(let value) = self { value } else { nil } }
    public var bool: Bool? { if case .bool(let value) = self { value } else { nil } }
    public var array: [JSONValue]? { if case .array(let value) = self { value } else { nil } }
    public var object: [String: JSONValue]? { if case .object(let value) = self { value } else { nil } }

    /// The value as a `Decodable`, such as a frame's list.
    func decode<T: Decodable>(_ type: T.Type) -> T? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

/// An input the extension refused, or that the socket dropped before the answer came.
public struct PanelRefusal: Error, Equatable, LocalizedError {
    public var message: String
    public var errorDescription: String? { message }
}

extension Panel {
    /// Sends one input without waiting for its answer.
    func input(_ type: String, _ fields: [String: JSONValue] = [:]) {
        var frame = fields
        frame["type"] = .string(type)
        try? send(json: JSONValue.object(frame).json)
    }
}

/// Inputs waiting for their answer, by `ref`; called from the main actor and the library's threads.
final class Requests: @unchecked Sendable {
    private let lock = NSLock()
    private var next = 0
    private var waiting: [String: CheckedContinuation<JSONValue, Error>] = [:]

    /// Sends an input with a fresh `ref` and waits for the frame that answers it.
    func request(_ panel: Panel?, _ type: String, _ fields: [String: JSONValue]) async throws -> JSONValue {
        guard let panel else { throw PanelRefusal(message: "Closed") }
        let ref = lock.withLock {
            next += 1
            return "r\(next)"
        }
        let answer = try await withCheckedThrowingContinuation { continuation in
            lock.withLock { waiting[ref] = continuation }
            var frame = fields
            frame["ref"] = .string(ref)
            panel.input(type, frame)
            // As long as a large upload on a slow network takes.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(120))
                self?.giveUp(ref)
            }
        }
        if answer["type"]?.string == "error" {
            throw PanelRefusal(message: answer["message"]?.string ?? "Refused")
        }
        return answer
    }

    private func giveUp(_ ref: String) {
        let continuation = lock.withLock { waiting.removeValue(forKey: ref) }
        continuation?.resume(throwing: PanelRefusal(message: "No answer; try again"))
    }

    /// Hands a frame to the input it answers; false for one that answers none.
    func answer(_ frame: JSONValue) -> Bool {
        guard let ref = frame["ref"]?.string,
            let continuation = lock.withLock({ waiting.removeValue(forKey: ref) })
        else { return false }
        continuation.resume(returning: frame)
        return true
    }

    private var open = false

    /// The socket dropped after it was open: what waits gets no answer. While it opens, inputs
    /// wait for it.
    func status(_ status: PanelStatus) {
        let dropped: [CheckedContinuation<JSONValue, Error>] = lock.withLock {
            let isOpen = if case .open = status { true } else { false }
            let isClosed = if case .closed = status { true } else { false }
            defer { open = isOpen }
            guard (open && !isOpen) || isClosed else { return [] }
            defer { waiting = [:] }
            return Array(waiting.values)
        }
        for continuation in dropped {
            continuation.resume(throwing: PanelRefusal(message: "The connection dropped; try again"))
        }
    }
}
