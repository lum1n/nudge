// How an assistant's robot looks: a few choices, not a picture, so it stays small, recolours on
// every platform, and everyone in a room sees the same one. As the web's `appearance.ts`.
import Foundation

enum EyeShape: String, CaseIterable, Sendable {
    case pill, round, square, wide
}

enum Accessory: String, CaseIterable, Sendable {
    case none, antenna, headphones, sprout, crown
}

struct Appearance: Equatable, Sendable {
    /// The ribbon's two ends, as `#rrggbb`.
    var body: (String, String)
    var eyes: String
    var sparks: String
    var eyeShape: EyeShape
    var accessory: Accessory

    static func == (a: Appearance, b: Appearance) -> Bool {
        a.body == b.body && a.eyes == b.eyes && a.sparks == b.sparks && a.eyeShape == b.eyeShape
            && a.accessory == b.accessory
    }

    /// The robot of the app icon.
    static let nudge = Appearance(
        body: ("#1438f5", "#19e6f0"), eyes: "#3ff6ff", sparks: "#2fe6b8", eyeShape: .pill, accessory: .none)

    static let presets: KeyValuePairs<String, Appearance> = [
        "Nudge": .nudge,
        "Ember": Appearance(
            body: ("#e8361c", "#ffb238"), eyes: "#ffd36b", sparks: "#ff7a45", eyeShape: .pill, accessory: .none),
        "Moss": Appearance(
            body: ("#127a4a", "#a5e86a"), eyes: "#b8ff8a", sparks: "#e4f36a", eyeShape: .round, accessory: .none),
        "Grape": Appearance(
            body: ("#5b21d6", "#e45bff"), eyes: "#f0a8ff", sparks: "#ff6fcf", eyeShape: .wide, accessory: .none),
        "Graphite": Appearance(
            body: ("#30343c", "#8a94a6"), eyes: "#ffffff", sparks: "#c9d1de", eyeShape: .square, accessory: .none),
    ]
}

/// A `#rrggbb` colour as red, green and blue from 0 to 255; black for anything else.
func rgb(_ hex: String) -> (Int, Int, Int) {
    let digits = hex.hasPrefix("#") ? hex.dropFirst() : Substring(hex)
    guard digits.count == 6, let value = Int(digits, radix: 16) else { return (0, 0, 0) }
    return ((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
}

/// `from` moved toward `to` by `k`, both `#rrggbb`.
func tint(_ from: String, _ to: String, _ k: Double) -> String {
    let a = rgb(from)
    let b = rgb(to)
    func channel(_ x: Int, _ y: Int) -> Int { Int((Double(x) + Double(y - x) * k).rounded(.toNearestOrAwayFromZero)) }
    return String(format: "#%02x%02x%02x", channel(a.0, b.0), channel(a.1, b.1), channel(a.2, b.2))
}
