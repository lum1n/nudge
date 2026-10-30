import Charts
#if os(iOS)
import EventKitUI
#endif
import MapKit
import Nudge
import SwiftUI

// The cards' maps, charts, stats, progress bars and timelines (ADR 29), with MapKit and Swift Charts.

/// The series' colours, in this order and never cycled, so each pair next to each other stays apart
/// for colour-blind readers too; dark mode gets the same hues stepped for it.
private let lightSeries: [UInt32] = [0x2A78D6, 0xEB6834, 0x1BAF7A, 0xEDA100, 0xE87BA4, 0x008300, 0x6250D6, 0xE34948]
private let darkSeries: [UInt32] = [0x3987E5, 0xD95926, 0x199E70, 0xC98500, 0xD55181, 0x008300, 0x9085E9, 0xE66767]

private func seriesColors(_ scheme: ColorScheme) -> [Color] {
    (scheme == .dark ? darkSeries : lightSeries).map {
        Color(red: Double($0 >> 16 & 0xFF) / 255, green: Double($0 >> 8 & 0xFF) / 255, blue: Double($0 & 0xFF) / 255)
    }
}

/// A card's map: Apple Maps around its markers and path. A tap opens it in Maps.
struct CardMapView: View {
    let markers: [UiMarker]
    let path: [UiPoint]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Map(initialPosition: .automatic, interactionModes: []) {
                if path.count > 1 {
                    MapPolyline(coordinates: path.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) })
                        .stroke(.blue, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                }
                ForEach(Array(markers.enumerated()), id: \.offset) { index, marker in
                    Marker(marker.label, monogram: Text("\(index + 1)"), coordinate: CLLocationCoordinate2D(latitude: marker.lat, longitude: marker.lon))
                }
            }
            .frame(height: 200)
            .clipShape(.rect(cornerRadius: 10))
            .onTapGesture(perform: open)
            .accessibilityLabel(markers.map(\.label).joined(separator: ", "))
            .accessibilityAddTraits(.isButton)
            if markers.count > 1 {
                ForEach(Array(markers.enumerated()), id: \.offset) { index, marker in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(index + 1)").foregroundStyle(.secondary).frame(minWidth: 16, alignment: .trailing)
                        Text(marker.label)
                    }
                }
            }
        }
    }

    private func open() {
        let items = markers.map { marker in
            let item = MKMapItem(location: CLLocation(latitude: marker.lat, longitude: marker.lon), address: nil)
            item.name = marker.label
            return item
        }
        if !items.isEmpty {
            MKMapItem.openMaps(with: items)
        } else if let first = path.first {
            MKMapItem(location: CLLocation(latitude: first.lat, longitude: first.lon), address: nil).openInMaps()
        }
    }
}

/// A card's chart with Swift Charts: bars, lines, areas or a donut, with a legend for more than one
/// series and the values in its accessibility labels.
struct CardChartView: View {
    let chart: UiChart
    @Environment(\.colorScheme) private var scheme
    @State private var table = false

    private struct Point: Identifiable {
        let id: Int
        let series: String
        let label: String
        let value: Double
    }

    private var points: [Point] {
        chart.series.enumerated().flatMap { s, series in
            series.values.enumerated().compactMap { index, value in
                guard let value, index < chart.labels.count else { return nil }
                return Point(id: s * 1000 + index, series: series.name, label: chart.labels[index], value: value)
            }
        }
    }

    private var uniqueLabels: [String] {
        var seen = Set<String>()
        return chart.labels.filter { seen.insert($0).inserted }
    }

    private func said(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...2))) + (chart.unit.map { " \($0)" } ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if table { valuesTable } else { plot }
            Button(table ? "Show the chart" : "Show as a table") { table.toggle() }.font(.caption).buttonStyle(.borderless)
        }
    }

    /// The values as a table, for reading them exactly.
    private var valuesTable: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                GridRow {
                    Text("")
                    ForEach(Array(chart.series.enumerated()), id: \.offset) { Text($1.name).fontWeight(.semibold) }
                }
                Divider()
                ForEach(Array(chart.labels.enumerated()), id: \.offset) { row, label in
                    GridRow {
                        Text(label).foregroundStyle(.secondary)
                        ForEach(Array(chart.series.enumerated()), id: \.offset) { _, series in
                            Text(row < series.values.count ? series.values[row].map(said) ?? "–" : "–").monospacedDigit()
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var plot: some View {
        let colors = seriesColors(scheme)
        if chart.kind == "pie" {
            pie(colors)
        } else {
            Chart(points) { point in
                if chart.kind == "bar" {
                    BarMark(x: .value("", point.label), y: .value(chart.unit ?? "", point.value))
                        .foregroundStyle(by: .value("", point.series))
                        .position(by: .value("", point.series))
                        .cornerRadius(4)
                        .accessibilityLabel("\(point.label), \(point.series)")
                        .accessibilityValue(said(point.value))
                } else {
                    if chart.kind == "area" {
                        AreaMark(x: .value("", point.label), y: .value(chart.unit ?? "", point.value), series: .value("", point.series))
                            .foregroundStyle(by: .value("", point.series))
                            .opacity(chart.series.count > 1 ? 0.15 : 0.25)
                    }
                    LineMark(x: .value("", point.label), y: .value(chart.unit ?? "", point.value), series: .value("", point.series))
                        .foregroundStyle(by: .value("", point.series))
                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .symbol(.circle)
                        .symbolSize(chart.labels.count <= 24 ? 30 : 0)
                        .accessibilityLabel("\(point.label), \(point.series)")
                        .accessibilityValue(said(point.value))
                }
            }
            .chartForegroundStyleScale(domain: chart.series.map(\.name), range: Array(colors.prefix(chart.series.count)))
            .chartLegend(chart.series.count > 1 ? .visible : .hidden)
            // Labels in the order the card gives them, and as few as fit.
            .chartXScale(domain: uniqueLabels)
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 6)) }
            .frame(height: 180)
        }
    }

    private func pie(_ colors: [Color]) -> some View {
        let values = (chart.series.first?.values ?? []).map { Swift.max(0, $0 ?? 0) }
        let total = values.reduce(0, +)
        let slices = Array(zip(chart.labels, values).enumerated())
        return HStack(spacing: 16) {
            Chart(slices, id: \.offset) { index, slice in
                SectorMark(angle: .value("", slice.1), innerRadius: .ratio(0.6), angularInset: 1)
                    .foregroundStyle(colors[index % colors.count])
                    .accessibilityLabel(slice.0)
                    .accessibilityValue(said(slice.1))
            }
            .frame(width: 128, height: 128)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(slices, id: \.offset) { index, slice in
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2).fill(colors[index % colors.count]).frame(width: 10, height: 10)
                        Text(slice.0).font(.caption)
                        if total > 0 {
                            Text("\(said(slice.1)) · \(Int((slice.1 / total * 100).rounded()))%").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}

/// Headline numbers in tiles, each with what changed.
struct CardStatsView: View {
    let stats: [UiStat]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), alignment: .leading)], alignment: .leading, spacing: 8) {
            ForEach(Array(stats.enumerated()), id: \.offset) { _, stat in
                VStack(alignment: .leading, spacing: 2) {
                    Text(stat.label).font(.caption).foregroundStyle(.secondary)
                    Text(stat.value).font(.title3.weight(.semibold)).monospacedDigit()
                    if let change = stat.change {
                        Text(change).font(.caption).foregroundStyle(stat.tone == "good" ? .green : stat.tone == "bad" ? .red : .secondary)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
            }
        }
    }
}

/// Progress bars, each with its label and how far along it is.
struct CardProgressView: View {
    let items: [UiProgressItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                let share = item.value / item.max
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(item.label)
                        Spacer()
                        Text(item.note ?? share.formatted(.percent.precision(.fractionLength(0)))).foregroundStyle(.secondary).monospacedDigit()
                    }
                    ProgressView(value: Swift.min(1, Swift.max(0, share))).tint(share > 1 ? .orange : .accentColor)
                }
            }
        }
    }
}

/// Steps in order, with a dot for each: filled when done, ringed when current.
struct CardTimelineView: View {
    let steps: [UiStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .top, spacing: 10) {
                    VStack(spacing: 0) {
                        Circle()
                            .fill(step.state == "upcoming" || step.state == nil ? Color.secondary.opacity(0.4) : Color.accentColor)
                            .overlay { if step.state == "current" { Circle().stroke(Color.accentColor.opacity(0.3), lineWidth: 4) } }
                            .frame(width: 10, height: 10)
                            .padding(.top, 5)
                        if index < steps.count - 1 { Rectangle().fill(.secondary.opacity(0.3)).frame(width: 1).frame(maxHeight: .infinity) }
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            if let time = step.time { Text(time).foregroundStyle(.secondary).monospacedDigit() }
                            Text(step.title).fontWeight(step.state == "current" ? .semibold : nil)
                                .foregroundStyle(step.state == "upcoming" ? .secondary : .primary)
                        }
                        if let subtitle = step.subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
                    }
                    .padding(.bottom, 8)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A calendar event, with a button that adds it to the calendar: the system's editor on iOS, which
/// needs no access to the calendar, and Calendar's own import of the event on the Mac.
struct CardEventView: View {
    let event: UiEvent
    @State private var adding = false

    private var when: String {
        guard let interval = event.interval else { return event.start }
        if event.allDay {
            let last = interval.end.addingTimeInterval(-1)
            return Calendar.current.isDate(interval.start, inSameDayAs: last)
                ? interval.start.formatted(date: .complete, time: .omitted)
                : (interval.start..<last).formatted(.interval.day().month(.wide).year().weekday(.wide))
        }
        return (interval.start..<interval.end).formatted(.interval.day().month(.wide).year().weekday(.wide).hour().minute())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(event.title).font(.subheadline.weight(.semibold))
            Text(when).foregroundStyle(.secondary)
            if let location = event.location { Text(location).foregroundStyle(.secondary) }
            if let notes = event.notes { Text(notes).font(.caption).foregroundStyle(.secondary) }
            Button("Add to calendar", systemImage: "calendar.badge.plus", action: add).buttonStyle(.glass).padding(.top, 4)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 10))
        #if os(iOS)
        .sheet(isPresented: $adding) { EventEditor(event: event) }
        #endif
    }

    private func add() {
        #if os(iOS)
        adding = true
        #else
        // Calendar imports an .ics it is handed, asking which calendar.
        let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).ics")
        if (try? ics.write(to: url, atomically: true, encoding: .utf8)) != nil { NSWorkspace.shared.open(url) }
        #endif
    }

    #if os(macOS)
    private var ics: String {
        guard let interval = event.interval else { return "" }
        let utc = ISO8601DateFormatter()
        utc.formatOptions = [.withYear, .withMonth, .withDay, .withTime, .withTimeZone]
        let stamp = { (date: Date) in utc.string(from: date).replacingOccurrences(of: "-", with: "").replacingOccurrences(of: ":", with: "") }
        let day = { (date: Date) in
            let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
            return String(format: "%04d%02d%02d", parts.year!, parts.month!, parts.day!)
        }
        let text = { (value: String) in
            value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: ";", with: "\\;")
                .replacingOccurrences(of: ",", with: "\\,").replacingOccurrences(of: "\n", with: "\\n")
        }
        var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Nudge//Cards//EN", "BEGIN:VEVENT",
                     "UID:\(UUID().uuidString)@nudge", "DTSTAMP:\(stamp(.now))"]
        if event.allDay {
            lines += ["DTSTART;VALUE=DATE:\(day(interval.start))", "DTEND;VALUE=DATE:\(day(interval.end))"]
        } else {
            lines += ["DTSTART:\(stamp(interval.start))", "DTEND:\(stamp(interval.end))"]
        }
        lines.append("SUMMARY:\(text(event.title))")
        if let location = event.location { lines.append("LOCATION:\(text(location))") }
        if let notes = event.notes { lines.append("DESCRIPTION:\(text(notes))") }
        lines += ["END:VEVENT", "END:VCALENDAR"]
        return lines.joined(separator: "\r\n") + "\r\n"
    }
    #endif
}

#if os(iOS)
/// The system's event editor, filled in; it adds to the calendar without the app asking for access.
private struct EventEditor: UIViewControllerRepresentable {
    let event: UiEvent
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(dismiss: dismiss) }

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let store = EKEventStore()
        let item = EKEvent(eventStore: store)
        item.title = event.title
        item.isAllDay = event.allDay
        if let interval = event.interval {
            item.startDate = interval.start
            // An all-day event's end is its last day.
            item.endDate = event.allDay ? interval.end.addingTimeInterval(-1) : interval.end
        }
        item.location = event.location
        item.notes = event.notes
        let editor = EKEventEditViewController()
        editor.eventStore = store
        editor.event = item
        editor.editViewDelegate = context.coordinator
        return editor
    }

    func updateUIViewController(_ controller: EKEventEditViewController, context: Context) {}

    final class Coordinator: NSObject, EKEventEditViewDelegate {
        let dismiss: DismissAction
        init(dismiss: DismissAction) { self.dismiss = dismiss }
        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            dismiss()
        }
    }
}
#endif

/// Boxes in rows by where the arrows lead (columns when it goes right), as the web app lays them out.
struct CardDiagramView: View {
    let diagram: UiDiagram

    private let boxWidth: CGFloat = 132
    private let boxHeight: CGFloat = 40
    private let gap: CGFloat = 20
    private let rankGap: CGFloat = 44

    var body: some View {
        let places = diagram.layout()
        let across = diagram.direction == "right"
        let ranks = (places.values.map(\.rank).max() ?? 0) + 1
        var perRank: [Int: Int] = [:]
        for place in places.values { perRank[place.rank, default: 0] += 1 }
        let widest = perRank.values.max() ?? 1
        let span = { (count: Int, box: CGFloat, between: CGFloat) in CGFloat(count) * box + CGFloat(count - 1) * between }
        let spread = across ? span(widest, boxHeight, gap) : span(widest, boxWidth, gap)
        let size = across ? CGSize(width: span(ranks, boxWidth, rankGap), height: spread) : CGSize(width: spread, height: span(ranks, boxHeight, rankGap))
        let center = { (id: String) -> CGPoint in
            let place = places[id]!
            let count = perRank[place.rank]!
            let inRank = across ? span(count, boxHeight, gap) : span(count, boxWidth, gap)
            let offset = (spread - inRank) / 2 + CGFloat(place.order) * ((across ? boxHeight : boxWidth) + gap)
            let step = CGFloat(place.rank) * ((across ? boxWidth : boxHeight) + rankGap)
            return across
                ? CGPoint(x: step + boxWidth / 2, y: offset + boxHeight / 2)
                : CGPoint(x: offset + boxWidth / 2, y: step + boxHeight / 2)
        }
        let label = { (id: String) in diagram.nodes.first { $0.id == id }?.label ?? id }
        ScrollView(.horizontal) {
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    for edge in diagram.edges where edge.from != edge.to {
                        let (start, end) = ends(center(edge.from), center(edge.to), across: across)
                        var line = Path()
                        line.move(to: start)
                        line.addLine(to: end)
                        context.stroke(line, with: .style(.secondary), lineWidth: 1.5)
                        let angle = atan2(end.y - start.y, end.x - start.x)
                        var head = Path()
                        head.move(to: end)
                        head.addLine(to: CGPoint(x: end.x - 7 * cos(angle - 0.45), y: end.y - 7 * sin(angle - 0.45)))
                        head.addLine(to: CGPoint(x: end.x - 7 * cos(angle + 0.45), y: end.y - 7 * sin(angle + 0.45)))
                        head.closeSubpath()
                        context.fill(head, with: .style(.secondary))
                    }
                }
                .frame(width: size.width, height: size.height)
                ForEach(Array(diagram.edges.enumerated()), id: \.offset) { _, edge in
                    if let text = edge.label, edge.from != edge.to {
                        let (start, end) = ends(center(edge.from), center(edge.to), across: across)
                        Text(text).font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 2)
                            .background(.background)
                            .position(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
                    }
                }
                ForEach(diagram.nodes, id: \.id) { node in
                    Text(node.label)
                        .font(.caption)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .padding(.horizontal, 4)
                        .frame(width: boxWidth, height: boxHeight)
                        .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 6))
                        .overlay { RoundedRectangle(cornerRadius: 6).stroke(.secondary.opacity(0.6)) }
                        .position(center(node.id))
                }
            }
            .frame(width: size.width, height: size.height)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(diagram.edges.map { "\(label($0.from)) to \(label($0.to))" }.joined(separator: ", "))
    }

    /// From the edge of one box to the facing edge of the other.
    private func ends(_ from: CGPoint, _ to: CGPoint, across: Bool) -> (CGPoint, CGPoint) {
        if across {
            if to.x == from.x { return (CGPoint(x: from.x, y: from.y + boxHeight / 2), CGPoint(x: to.x, y: to.y - boxHeight / 2)) }
            let sign: CGFloat = to.x > from.x ? 1 : -1
            return (CGPoint(x: from.x + sign * boxWidth / 2, y: from.y), CGPoint(x: to.x - sign * boxWidth / 2, y: to.y))
        }
        if to.y == from.y { return (CGPoint(x: from.x + boxWidth / 2, y: from.y), CGPoint(x: to.x - boxWidth / 2, y: to.y)) }
        let sign: CGFloat = to.y > from.y ? 1 : -1
        return (CGPoint(x: from.x, y: from.y + sign * boxHeight / 2), CGPoint(x: to.x, y: to.y - sign * boxHeight / 2))
    }
}
