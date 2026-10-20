// Tells home where the player is, while the app is open and they turned it on in their profile.
// Home keeps it as a private value: the model only ever sees a placeholder for it, and only in the
// player's own room and private messages. The place's name comes from Apple's geocoder, which
// sees the coordinates; nothing goes to any other server.
import CoreLocation
import Foundation
import Nudge
import Observation

@MainActor @Observable
final class LocationSharing: NSObject {
    /// Whether the player chose to share where they are, on this device.
    private(set) var enabled: Bool
    /// What home last said it knows.
    private(set) var known: KnownLocation?
    /// Why the last update failed, or why the device won't tell.
    private(set) var problem: String?

    /// Home's client; nil while signed out.
    @ObservationIgnored var client: NudgeClient? {
        didSet { if client !== oldValue { known = nil; resume() } }
    }
    @ObservationIgnored private let manager = CLLocationManager()
    @ObservationIgnored private let geocoder = CLGeocoder()
    @ObservationIgnored private var active = true
    @ObservationIgnored private let defaults = UserDefaults.standard
    private static let enabledKey = "location.share"

    override init() {
        enabled = defaults.bool(forKey: Self.enabledKey)
        super.init()
        manager.delegate = self
        // A street's worth is enough to say what is near, and kind to the battery.
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = 200
    }

    /// Turns sharing on (asking for permission the first time) or off. Off also has home forget
    /// where the player was.
    func setEnabled(_ on: Bool) async {
        enabled = on
        defaults.set(on, forKey: Self.enabledKey)
        problem = nil
        if on {
            resume()
        } else {
            manager.stopUpdatingLocation()
            guard let client else { return }
            do {
                known = try await client.forgetLocation().location
            } catch {
                problem = explain(error)
            }
        }
    }

    /// Updates only while the app is in the foreground.
    func setActive(_ active: Bool) {
        self.active = active
        if active { resume() } else { manager.stopUpdatingLocation() }
    }

    /// What home knows now, for the profile.
    func refresh() async {
        guard let client else { return }
        known = try? await client.personal().location
    }

    private func resume() {
        guard enabled, active, client != nil else {
            manager.stopUpdatingLocation()
            return
        }
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            problem = "Nudge may not use this device's location. Allow it in the system's Settings."
        default:
            manager.startUpdatingLocation()
        }
    }

    private func share(_ location: CLLocation) async {
        guard let client, enabled else { return }
        let place = try? await geocoder.reverseGeocodeLocation(location).first.map(Self.describe)
        do {
            let details = try await client.shareLocation(
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude,
                place: place ?? nil)
            known = details.location
            problem = nil
        } catch {
            problem = explain(error)
        }
    }

    /// Such as "Storgata 5, Oslo": the street address, or the place's name, and the town.
    private static func describe(_ placemark: CLPlacemark) -> String? {
        let street = [placemark.thoroughfare, placemark.subThoroughfare]
            .compactMap { $0 }
            .joined(separator: " ")
        let first = street.isEmpty ? placemark.name : street
        let parts = [first, placemark.locality ?? placemark.administrativeArea, placemark.isoCountryCode]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}

extension LocationSharing: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in self.resume() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        Task { @MainActor in await self.share(last) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Not knowing for a moment is no reason to stop; denial shows through the authorization.
        if (error as? CLError)?.code == .locationUnknown { return }
        Task { @MainActor in self.problem = error.localizedDescription }
    }
}
