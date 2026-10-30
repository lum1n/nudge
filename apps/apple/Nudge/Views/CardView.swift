import Nudge
import SwiftUI

extension EnvironmentValues {
    /// Presses a button on a card in the room on screen (ADR 27); nil where cards can't be pressed.
    @Entry var pressCard: ((_ callId: String, _ card: UiCard, _ button: UiButton, _ values: [String: UiValue]) async throws -> Void)?
}

/// A card a tool showed in the chat (ADR 27): its blocks, fields and buttons. A press posts it,
/// and it comes back in the chat as the reader's message.
struct CardView: View {
    let tool: ToolPart
    let card: UiCard
    @Environment(\.pressCard) private var pressCard
    @State private var values: [String: UiValue] = [:]
    @State private var busy = false
    @State private var problem: String?

    private var pressed: UiPressed? { tool.pressed }
    private var done: Bool { pressed != nil && card.once }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = card.title { Text(title).font(.headline) }
            ForEach(Array(card.blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
            if !done {
                ForEach(card.fields, id: \.name) { field in
                    FieldView(field: field, value: binding(field)).disabled(busy || pressCard == nil)
                }
            }
            if !card.buttons.isEmpty {
                HStack {
                    ForEach(card.buttons) { button in
                        Button(button.label, role: button.style == "danger" ? .destructive : nil) { press(button) }
                            .buttonStyle(button.style == "primary" ? AnyPrimitiveButtonStyle(.glassProminent) : AnyPrimitiveButtonStyle(.glass))
                            .disabled(busy || done || pressCard == nil)
                    }
                }
            }
            if let pressed {
                let label = card.buttons.first { $0.id == pressed.button }?.label ?? pressed.button
                Text("\(pressed.by) pressed “\(label)”").font(.caption).foregroundStyle(.secondary)
            }
            if let problem { Text(problem).font(.callout).foregroundStyle(.red) }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
    }

    private func binding(_ field: UiField) -> Binding<UiValue?> {
        Binding(get: { values[field.name] }, set: { values[field.name] = $0 })
    }

    private func press(_ button: UiButton) {
        guard let pressCard else { return }
        problem = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await pressCard(tool.callId, card, button, values)
                values = [:]
            } catch let missing as MissingField {
                problem = String(localized: "Fill in “\(missing.label)”")
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

/// A button style chosen at run time.
private struct AnyPrimitiveButtonStyle: PrimitiveButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: PrimitiveButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}

private struct BlockView: View {
    let block: UiBlock

    var body: some View {
        switch block {
        case .heading(let text):
            Text(text).font(.subheadline.weight(.semibold))
        case .text(let markdown):
            Text((try? AttributedString(
                markdown: markdown,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)))
                ?? AttributedString(markdown))
        case .keyValues(let pairs):
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 2) {
                ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                    GridRow {
                        Text(pair.label).foregroundStyle(.secondary)
                        Text(pair.value)
                    }
                }
            }
        case .list(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading) {
                        Text(item.title)
                        if let subtitle = item.subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
        case .table(let columns, let rows):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                    GridRow { ForEach(Array(columns.enumerated()), id: \.offset) { Text($1).fontWeight(.semibold) } }
                    Divider()
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(columns.indices, id: \.self) { Text($0 < row.count ? row[$0] : "") }
                        }
                    }
                }
            }
        case .image(_, let alt):
            // Attachments aren't fetched in the app yet: what the image shows, in words.
            Text(alt).font(.caption).foregroundStyle(.secondary)
        case .divider:
            Divider()
        case .map(let markers, let path):
            CardMapView(markers: markers, path: path)
        case .chart(let chart):
            CardChartView(chart: chart)
        case .stats(let stats):
            CardStatsView(stats: stats)
        case .progress(let items):
            CardProgressView(items: items)
        case .timeline(let steps):
            CardTimelineView(steps: steps)
        }
    }
}

private struct FieldView: View {
    let field: UiField
    @Binding var value: UiValue?

    /// Days and times as cards send them, in the device's own time zone.
    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = format
        return formatter
    }

    private var label: String { field.optional ? String(localized: "\(field.label) (optional)") : field.label }

    var body: some View {
        switch field.type {
        case "boolean":
            Toggle(label, isOn: Binding(
                get: { if case .flag(let on) = value { on } else { false } },
                set: { value = .flag($0) }))
        case "choice":
            Picker(label, selection: Binding(
                get: { if case .text(let text) = value { text } else { "" } },
                set: { value = .text($0) })
            ) {
                Text("Choose…").tag("")
                ForEach(field.options, id: \.self) { Text($0).tag($0) }
            }
        case "date", "time":
            let format = field.type == "date" ? "yyyy-MM-dd" : "HH:mm"
            if case .text(let text) = value, let date = Self.formatter(format).date(from: text) {
                DatePicker(
                    label,
                    selection: Binding(get: { date }, set: { value = .text(Self.formatter(format).string(from: $0)) }),
                    displayedComponents: field.type == "date" ? .date : .hourAndMinute)
            } else {
                LabeledContent(label) {
                    // Nothing is picked until they pick, so a required field isn't filled in for them.
                    Button(field.placeholder ?? String(localized: "Choose…")) { value = .text(Self.formatter(format).string(from: .now)) }
                }
            }
        default:
            TextField(label, text: Binding(
                get: {
                    switch value {
                    case .text(let text): text
                    case .number(let number): number.formatted()
                    default: ""
                    }
                },
                set: { text in
                    // A number field's text that isn't a number counts as empty.
                    if field.type == "number" { value = Double(text).map(UiValue.number) ?? .text("") } else { value = .text(text) }
                }),
                prompt: field.placeholder.map { Text($0) },
                axis: field.multiline ? .vertical : .horizontal)
            .lineLimit(field.multiline ? 3...8 : 1...1)
            .textFieldStyle(.roundedBorder)
            #if os(iOS)
            .keyboardType(field.type == "number" ? .decimalPad : .default)
            #endif
        }
    }
}
