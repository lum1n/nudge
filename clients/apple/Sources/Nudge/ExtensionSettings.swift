// An extension's settings as a form: the fields its JSON Schema (as TypeBox writes it) describes,
// for an app to draw natively, and the settings as a JSON object to edit and save.
import Foundation
import NudgeFFI

/// One setting: its key, a label to show, its help, and its default.
public struct SettingField: Equatable, Sendable, Identifiable {
    public var name: String
    public var label: String
    public var description: String?
    public var required: Bool
    public var defaultValue: JSONValue?
    public var kind: SettingKind
    public var id: String { name }

    /// What kind of control a setting takes.
    public indirect enum SettingKind: Equatable, Sendable {
        /// A string; `secret` ones (a password, a token, a key) are typed without being shown.
        case text(secret: Bool)
        case number(integer: Bool, minimum: Double?, maximum: Double?)
        case toggle
        /// One of a fixed few values.
        case choice([JSONValue])
        /// A list of strings, one per line.
        case lines
        /// An object of its own fields.
        case group([SettingField])
        /// A list of objects, such as mail accounts, each with these fields.
        case items([SettingField])
        /// Anything else, edited as JSON.
        case json
    }

    /// The fields of an object schema, given as JSON, in the schema's order; none for no schema.
    public static func fields(schemaJson: String?) -> [SettingField] {
        guard let schemaJson, let schema = Schema(json: schemaJson) else { return [] }
        return fields(of: schema)
    }

    private static func fields(of schema: Schema) -> [SettingField] {
        let merged = schema.mergingAllOf
        let required = Set(merged["required"]?.value.array?.compactMap(\.string) ?? [])
        return (merged["properties"]?.members ?? []).map { name, property in
            SettingField(
                name: name, label: property["title"]?.value.string ?? humanize(name),
                description: property["description"]?.value.string, required: required.contains(name),
                defaultValue: property["default"]?.value, kind: kind(of: property, named: name))
        }
    }

    private static func kind(of schema: Schema, named name: String) -> SettingKind {
        if let choices = schema.choices { return .choice(choices) }
        switch schema.type {
        case "boolean": return .toggle
        case "number", "integer":
            return .number(
                integer: schema.type == "integer", minimum: schema["minimum"]?.value.number,
                maximum: schema["maximum"]?.value.number)
        case "string":
            let marked = schema["format"]?.value.string == "password" || schema["writeOnly"]?.value.bool == true
            let named = name.range(of: "token|password|secret|key$", options: [.regularExpression, .caseInsensitive])
            return .text(secret: marked || named != nil)
        case "array":
            guard let items = schema["items"] else { return .json }
            if items.type == "string" && items.choices == nil { return .lines }
            if items.type == "object" && items.mergingAllOf["properties"] != nil { return .items(fields(of: items)) }
            return .json
        case "object":
            return schema.mergingAllOf["properties"] != nil ? .group(fields(of: schema)) : .json
        default: return .json
        }
    }

    /// `pollSeconds` → "Poll seconds".
    private static func humanize(_ name: String) -> String {
        var words = ""
        var previous: Character?
        for character in name {
            if character == "_" || character == "-" {
                if words.last != " " { words.append(" ") }
            } else {
                if character.isUppercase, let previous, previous.isLowercase || previous.isNumber { words.append(" ") }
                words.append(character)
            }
            previous = character
        }
        let lower = words.lowercased()
        return lower.prefix(1).uppercased() + lower.dropFirst()
    }
}

/// A JSON Schema with its objects' keys in order, which `JSONValue`'s dictionaries don't keep.
private indirect enum Schema {
    case object([(String, Schema)])
    case array([Schema])
    case scalar(JSONValue)

    init?(json: String) {
        var reader = Reader(text: Array(json.utf8))
        guard let schema = reader.value() else { return nil }
        self = schema
    }

    subscript(key: String) -> Schema? {
        if case .object(let members) = self { members.first { $0.0 == key }?.1 } else { nil }
    }

    var members: [(String, Schema)] { if case .object(let members) = self { members } else { [] } }

    var value: JSONValue {
        switch self {
        case .object(let members): .object(Dictionary(members.map { ($0.0, $0.1.value) }) { first, _ in first })
        case .array(let items): .array(items.map(\.value))
        case .scalar(let value): value
        }
    }

    var type: String? {
        if let type = self["type"]?.value.string { return type }
        if self["allOf"] != nil { return "object" }
        guard case .array(let parts)? = self["anyOf"] else { return nil }
        let types = Set(parts.map { $0["type"]?.value.string })
        return types.count == 1 ? types.first! : nil
    }

    /// The values it may take, when it is one of a fixed few.
    var choices: [JSONValue]? {
        if case .array(let values)? = self["enum"] { return values.map(\.value) }
        guard case .array(let parts)? = self["anyOf"], !parts.isEmpty else { return nil }
        let consts = parts.compactMap { $0["const"]?.value }
        return consts.count == parts.count ? consts : nil
    }

    /// `allOf` (TypeBox's intersections) as one object schema.
    var mergingAllOf: Schema {
        guard case .object(var members) = self, case .array(let parts)? = self["allOf"] else { return self }
        var properties = self["properties"]?.members ?? []
        var required = self["required"]?.value.array ?? []
        for part in parts {
            let merged = part.mergingAllOf
            for (name, property) in merged["properties"]?.members ?? [] {
                if let index = properties.firstIndex(where: { $0.0 == name }) {
                    properties[index].1 = property
                } else {
                    properties.append((name, property))
                }
            }
            for name in merged["required"]?.value.array ?? [] where !required.contains(name) { required.append(name) }
        }
        members.removeAll { ["allOf", "properties", "required"].contains($0.0) }
        members.append(("properties", .object(properties)))
        members.append(("required", .scalar(.array(required))))
        return .object(members)
    }

    /// Reads JSON text, keeping the order of keys.
    private struct Reader {
        let text: [UInt8]
        var at = 0

        mutating func value() -> Schema? {
            skipSpace()
            guard at < text.count else { return nil }
            switch text[at] {
            case UInt8(ascii: "{"):
                at += 1
                var members: [(String, Schema)] = []
                skipSpace()
                if step(over: "}") { return .object(members) }
                repeat {
                    guard case .scalar(.string(let key))? = value() else { return nil }
                    skipSpace()
                    guard step(over: ":"), let member = value() else { return nil }
                    members.append((key, member))
                    skipSpace()
                } while step(over: ",")
                return step(over: "}") ? .object(members) : nil
            case UInt8(ascii: "["):
                at += 1
                var items: [Schema] = []
                skipSpace()
                if step(over: "]") { return .array(items) }
                repeat {
                    guard let item = value() else { return nil }
                    items.append(item)
                    skipSpace()
                } while step(over: ",")
                return step(over: "]") ? .array(items) : nil
            default:
                // A string, number, true, false or null, read by JSONDecoder.
                let start = at
                if text[at] == UInt8(ascii: "\"") {
                    at += 1
                    while at < text.count && text[at] != UInt8(ascii: "\"") {
                        at += text[at] == UInt8(ascii: "\\") ? 2 : 1
                    }
                    at += 1
                } else {
                    while at < text.count && !Self.ends.contains(text[at]) { at += 1 }
                }
                guard at <= text.count,
                    let scalar = JSONValue(json: String(decoding: text[start..<at], as: UTF8.self))
                else { return nil }
                return .scalar(scalar)
            }
        }

        private static let space = Set(" \n\r\t".utf8)
        private static let ends = space.union(",}]".utf8)

        private mutating func skipSpace() {
            while at < text.count && Self.space.contains(text[at]) { at += 1 }
        }

        /// Steps over `character` when it is next.
        private mutating func step(over character: Unicode.Scalar) -> Bool {
            guard at < text.count, text[at] == UInt8(ascii: character) else { return false }
            at += 1
            return true
        }
    }
}

extension ExtensionSetup {
    /// The extension's settings, as an object.
    public var settings: [String: JSONValue] { JSONValue(json: settingsJson)?.object ?? [:] }

    /// The fields of its settings' form.
    public var settingFields: [SettingField] { SettingField.fields(schemaJson: schemaJson) }

    /// The setup as `saveExtensionSetups` takes it, with these settings, leaving out the
    /// top-level values that equal their defaults to keep the config short.
    public func saved(enabled: Bool, settings: [String: JSONValue], rooms: [RoomKind]?) -> SavedExtensionSetup {
        let defaults = Dictionary(settingFields.map { ($0.name, $0.defaultValue) }) { first, _ in first }
        let kept = settings.filter { key, value in (defaults[key] ?? nil).map { $0 != value } ?? true }
        return SavedExtensionSetup(
            from: from, enabled: enabled, settingsJson: JSONValue.object(kept).json, rooms: rooms)
    }
}
