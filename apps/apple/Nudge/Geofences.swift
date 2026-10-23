// Reminders when the player gets somewhere (ADR 17). Home says which places to watch, and Core
// Location's monitor wakes the app when the player gets to one or leaves it, also when it isn't
// running; the app then tells home, which says the reminder in its room. Where the places are
// stays between home and the device.
import CoreLocation
import Foundation
import Nudge
import Observation

@MainActor @Observable
final class Geofences {
    /// Whether the player turned on reminders when they arrive, on this device.
    private(set) var enabled: Bool
    /// How many places the device watches now.
    private(set) var watching = 0
    /// Why the device can't watch the places, if it can't.
    private(set) var problem: String?

    /// Home's client; nil while signed out. Only home hears where the player got to.
    @ObservationIgnored var client: NudgeClient? {
        didSet { if client !== oldValue { Task { await sync() } } }
    }
    @ObservationIgnored private let manager = CLLocationManager()
    @ObservationIgnored private var monitor: CLMonitor?
    @ObservationIgnored private var listening: Task<Void, Never>?
    @ObservationIgnored private var syncing = false
    @ObservationIgnored private let defaults = UserDefaults.standard
    private static let enabledKey = "location.arrive"
    /// The monitor's name: the same at every launch, so events that woke the app reach it.
    private static let monitorName = "nudge.arrival"
    private static let refresh = "refresh"

    init() {
        enabled = defaults.bool(forKey: Self.enabledKey)
        // Set up at launch, also when the system launched the app for a crossing.
        if enabled { Task { await self.start() } }
    }

    /// Turns it on (asking for location "Always" the first time) or off.
    func setEnabled(_ on: Bool) async {
        enabled = on
        defaults.set(on, forKey: Self.enabledKey)
        problem = nil
        if on {
            manager.requestAlwaysAuthorization()
            await start()
        }
        await sync()
    }

    private func start() async {
        guard monitor == nil else { return }
        let monitor = await CLMonitor(Self.monitorName)
        self.monitor = monitor
        listening = Task { [weak self] in
            do {
                for try await event in await monitor.events {
                    await self?.crossed(event)
                }
            } catch {
                await MainActor.run { self?.problem = error.localizedDescription }
            }
        }
    }

    /// Asks home which places to watch, from where the device is (or `at`), and watches those
    /// instead of the ones before. Called when the app opens and closes, and when the player leaves
    /// the circle home's places of a kind were found in.
    func sync(at: CLLocation? = nil) async {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        guard let client, enabled else {
            if let monitor { for id in await monitor.identifiers { await monitor.remove(id) } }
            watching = 0
            return
        }
        switch manager.authorizationStatus {
        case .denied, .restricted:
            problem = "Nudge may not use this device's location. Allow it Always in the system's Settings."
            return
        case .authorizedWhenInUse:
            problem = "Allow Nudge to use your location Always for reminders to work with the app closed."
        default:
            problem = nil
        }
        await start()
        guard let monitor else { return }
        do {
            let here = at ?? manager.location
            let answer = try await client.arrivalRegions(
                latitude: here?.coordinate.latitude, longitude: here?.coordinate.longitude)
            for id in await monitor.identifiers { await monitor.remove(id) }
            for region in answer.regions {
                await monitor.add(
                    CLMonitor.CircularGeographicCondition(
                        center: CLLocationCoordinate2D(latitude: region.latitude, longitude: region.longitude),
                        radius: region.radius),
                    identifier: region.id,
                    // Being somewhere already isn't arriving.
                    assuming: .unsatisfied)
            }
            if let circle = answer.refresh {
                await monitor.add(
                    CLMonitor.CircularGeographicCondition(
                        center: CLLocationCoordinate2D(latitude: circle.latitude, longitude: circle.longitude),
                        radius: circle.radius),
                    identifier: Self.refresh,
                    assuming: .satisfied)
            }
            watching = answer.regions.count
        } catch {
            // An assistant without the places extension answers 404: nothing to watch.
            watching = 0
            problem = explain(error)
        }
    }

    private func crossed(_ event: CLMonitor.Event) async {
        guard event.state == .satisfied || event.state == .unsatisfied else { return }
        let entered = event.state == .satisfied
        if event.identifier == Self.refresh {
            if !entered { await sync() }
            return
        }
        guard let client else { return }
        _ = try? await client.reportRegionEvent(regionId: event.identifier, entered: entered)
    }
}
