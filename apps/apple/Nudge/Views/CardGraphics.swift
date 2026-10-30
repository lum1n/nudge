import Charts
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
