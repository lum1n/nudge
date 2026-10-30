import Foundation

/// A card a tool shows in the chat (ADR 27): blocks to read, fields to fill in, buttons to press.
/// The app draws it with its own controls; a press reaches the room as the reader's message.
public struct UiCard: Decodable, Equatable, Sendable {
    public let title: String?
    /// Blocks of types this app knows; the others are left out.
    public let blocks: [UiBlock]
    public let fields: [UiField]
    public let buttons: [UiButton]
    /// Its buttons work once, for anyone.
    public let once: Bool
    /// Only who the answer was for may press.
    public let askerOnly: Bool

    enum CodingKeys: String, CodingKey { case v, title, blocks, fields, buttons, once, who }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard try container.decode(Int.self, forKey: .v) == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .v, in: container, debugDescription: "Not a v1 card")
        }
        title = try container.decodeIfPresent(String.self, forKey: .title)
        blocks = (try container.decodeIfPresent([Lenient<UiBlock>].self, forKey: .blocks) ?? []).compactMap(\.value)
        fields = try container.decodeIfPresent([UiField].self, forKey: .fields) ?? []
        buttons = try container.decodeIfPresent([UiButton].self, forKey: .buttons) ?? []
        once = try container.decodeIfPresent(Bool.self, forKey: .once) ?? true
        askerOnly = try container.decodeIfPresent(String.self, forKey: .who) == "asker"
    }
}

public enum UiBlock: Decodable, Equatable, Sendable {
    case heading(String)
    /// Markdown, as messages have it.
    case text(String)
    case keyValues([(label: String, value: String)])
    case list([(title: String, subtitle: String?)])
    case table(columns: [String], rows: [[String]])
    /// One of the room's attachments, by id.
    case image(attachment: String, alt: String)
    case divider
    /// Places on a map, and a line through `path` such as a route; the app picks the map.
    case map(markers: [UiMarker], path: [UiPoint])
    /// `bar`, `line`, `area` or `pie`: a value per label in each series, nil for a gap.
    case chart(UiChart)
    case stats([UiStat])
    case progress([UiProgressItem])
    case timeline([UiStep])

    struct Pair: Decodable { let label: String; let value: String }
    struct Item: Decodable { let title: String; let subtitle: String? }
    enum CodingKeys: String, CodingKey { case type, text, markdown, pairs, items, columns, rows, attachment, alt, markers, path }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "heading": self = .heading(try container.decode(String.self, forKey: .text))
        case "text": self = .text(try container.decode(String.self, forKey: .markdown))
        case "kv": self = .keyValues(try container.decode([Pair].self, forKey: .pairs).map { ($0.label, $0.value) })
        case "list": self = .list(try container.decode([Item].self, forKey: .items).map { ($0.title, $0.subtitle) })
        case "table":
            self = .table(columns: try container.decode([String].self, forKey: .columns), rows: try container.decode([[String]].self, forKey: .rows))
        case "image":
            self = .image(attachment: try container.decode(String.self, forKey: .attachment), alt: try container.decode(String.self, forKey: .alt))
        case "divider": self = .divider
        case "map":
            self = .map(
                markers: try container.decodeIfPresent([UiMarker].self, forKey: .markers) ?? [],
                path: try container.decodeIfPresent([UiPoint].self, forKey: .path) ?? [])
        case "chart": self = .chart(try UiChart(from: decoder))
        case "stats": self = .stats(try container.decode([UiStat].self, forKey: .items))
        case "progress": self = .progress(try container.decode([UiProgressItem].self, forKey: .items))
        case "timeline": self = .timeline(try container.decode([UiStep].self, forKey: .items))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "A block this app doesn't know")
        }
    }

    public static func == (a: UiBlock, b: UiBlock) -> Bool {
        switch (a, b) {
        case (.heading(let x), .heading(let y)), (.text(let x), .text(let y)): x == y
        case (.keyValues(let x), .keyValues(let y)): x.map(\.label) == y.map(\.label) && x.map(\.value) == y.map(\.value)
        case (.list(let x), .list(let y)): x.map(\.title) == y.map(\.title) && x.map(\.subtitle) == y.map(\.subtitle)
        case (.table(let c1, let r1), .table(let c2, let r2)): c1 == c2 && r1 == r2
        case (.image(let a1, let t1), .image(let a2, let t2)): a1 == a2 && t1 == t2
        case (.divider, .divider): true
        case (.map(let m1, let p1), .map(let m2, let p2)): m1 == m2 && p1 == p2
        case (.chart(let x), .chart(let y)): x == y
        case (.stats(let x), .stats(let y)): x == y
        case (.progress(let x), .progress(let y)): x == y
        case (.timeline(let x), .timeline(let y)): x == y
        default: false
        }
    }
}

public struct UiPoint: Decodable, Equatable, Sendable {
    public let lat: Double
    public let lon: Double
}

public struct UiMarker: Decodable, Equatable, Sendable {
    public let lat: Double
    public let lon: Double
    public let label: String
}

public struct UiChart: Decodable, Equatable, Sendable {
    /// `bar`, `line`, `area` or `pie`.
    public let kind: String
    public let labels: [String]
    public let series: [Series]
    /// What the values count, such as `kr`.
    public let unit: String?

    public struct Series: Decodable, Equatable, Sendable {
        public let name: String
        public let values: [Double?]
    }
}

public struct UiStat: Decodable, Equatable, Sendable {
    public let label: String
    public let value: String
    /// What changed, such as `+12%`.
    public let change: String?
    /// `good`, `bad`, `neutral`, or nil.
    public let tone: String?
}

public struct UiProgressItem: Decodable, Equatable, Sendable {
    public let label: String
    public let value: Double
    /// What full is.
    public let max: Double
    public let note: String?

    enum CodingKeys: String, CodingKey { case label, value, max, note }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = try container.decode(String.self, forKey: .label)
        value = try container.decode(Double.self, forKey: .value)
        max = try container.decodeIfPresent(Double.self, forKey: .max) ?? 100
        note = try container.decodeIfPresent(String.self, forKey: .note)
    }
}

public struct UiStep: Decodable, Equatable, Sendable {
    public let title: String
    public let time: String?
    public let subtitle: String?
    /// `done`, `current`, `upcoming`, or nil.
    public let state: String?
}

public struct UiField: Decodable, Equatable, Sendable {
    public let name: String
    public let label: String
    /// `text`, `number`, `boolean`, `choice`, `date` (`YYYY-MM-DD`) or `time` (`HH:MM`).
    public let type: String
    public let options: [String]
    public let placeholder: String?
    public let multiline: Bool
    public let optional: Bool

    enum CodingKeys: String, CodingKey { case name, label, type, options, placeholder, multiline, optional }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        label = try container.decode(String.self, forKey: .label)
        type = try container.decode(String.self, forKey: .type)
        options = try container.decodeIfPresent([String].self, forKey: .options) ?? []
        placeholder = try container.decodeIfPresent(String.self, forKey: .placeholder)
        multiline = try container.decodeIfPresent(Bool.self, forKey: .multiline) ?? false
        optional = try container.decodeIfPresent(Bool.self, forKey: .optional) ?? false
    }
}

public struct UiButton: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    /// `primary`, `danger`, or nil.
    public let style: String?
    /// Pressing it sends no field values and needs none filled in.
    public let skipsFields: Bool

    enum CodingKeys: String, CodingKey { case id, label, style, skipsFields }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decode(String.self, forKey: .label)
        style = try container.decodeIfPresent(String.self, forKey: .style)
        skipsFields = try container.decodeIfPresent(Bool.self, forKey: .skipsFields) ?? false
    }
}

/// The latest press on a card: which button, and the display name of who pressed it.
public struct UiPressed: Equatable, Sendable {
    public let button: String
    public let by: String

    public init(button: String, by: String) {
        self.button = button
        self.by = by
    }
}

/// What a field holds before it is sent.
public enum UiValue: Equatable, Sendable {
    case text(String)
    case number(Double)
    case flag(Bool)
}

/// A required field left empty; `label` names it.
public struct MissingField: Error, Equatable {
    public let label: String

    public init(label: String) { self.label = label }
}

/// Decodes what it can, and nil for what it can't, so one unknown block doesn't drop the card.
private struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension ToolPart {
    /// The card the tool showed, when its details hold one.
    public var card: UiCard? {
        guard let data = detailsJson?.data(using: .utf8) else { return nil }
        struct Details: Decodable { let ui: Lenient<UiCard>? }
        return (try? JSONDecoder().decode(Details.self, from: data))?.ui?.value
    }

    /// The latest press on the tool's card, if it was pressed.
    public var pressed: UiPressed? {
        guard let details = detailsJson.flatMap(JSONValue.init(json:)),
              case .object(let pressed)? = details["pressed"],
              case .string(let button)? = pressed["button"]
        else { return nil }
        var by = ""
        if case .object(let player)? = pressed["by"], case .string(let name)? = player["displayName"] { by = name }
        return UiPressed(button: button, by: by)
    }
}

extension UiCard {
    /// The values a press on `button` sends, as a JSON object, or nil for a button that skips them.
    /// Throws `MissingField` for a required field left empty.
    public func valuesJson(for button: UiButton, values: [String: UiValue]) throws -> String? {
        if button.skipsFields { return nil }
        var object: [String: JSONValue] = [:]
        for field in fields {
            let value = values[field.name] ?? (field.type == "boolean" ? .flag(false) : nil)
            switch value {
            case .text(let text) where !text.isEmpty: object[field.name] = .string(text)
            case .number(let number): object[field.name] = .number(number)
            case .flag(let on): object[field.name] = .bool(on)
            default:
                if !field.optional { throw MissingField(label: field.label) }
            }
        }
        let data = try JSONEncoder().encode(JSONValue.object(object))
        return String(decoding: data, as: UTF8.self)
    }
}

extension NudgeClient {
    /// Presses `button` on the card tool call `callId` showed in `room`, with `values`.
    public func press(room: String, callId: String, card: UiCard, button: UiButton, values: [String: UiValue]) async throws {
        let json = try card.valuesJson(for: button, values: values)
        try await pressCard(room: room, callId: callId, button: button.id, valuesJson: json)
    }
}
