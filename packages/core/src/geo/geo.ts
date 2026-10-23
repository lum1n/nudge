/** A point on the map, in degrees. */
export type GeoPoint = { readonly latitude: number; readonly longitude: number };

/** What the geocoder knows of one place. */
export type GeoPlace = GeoPoint & {
  /** Its own name, such as "Kiwi" or "Oslo S"; absent for a plain address. */
  readonly name?: string;
  /** The street address, such as "Storgata 5, 0155 Oslo"; absent where there is none. */
  readonly address?: string;
  readonly city?: string;
  /** Its OpenStreetMap tag as `key:value`, such as `shop:supermarket`. */
  readonly tag?: string;
  /** Stable across lookups, such as `N12345` for an OpenStreetMap node. */
  readonly id?: string;
};

export type TravelMode = "car" | "bike" | "foot";

/** One instruction of a route, and where it starts. */
export type GeoStep = {
  readonly text: string;
  readonly street?: string;
  readonly meters: number;
  readonly seconds: number;
  readonly at: GeoPoint;
};

export type GeoRoute = {
  readonly meters: number;
  readonly seconds: number;
  readonly steps: readonly GeoStep[];
};

/**
 * Addresses, places and routes from a service on the assistant's own server (ADR 17), so neither
 * where people are nor where they go reaches anyone else.
 */
export type Geo = {
  /** Places and addresses matching `query`, nearest to `near` first when given. */
  search(
    query: string,
    options?: { readonly near?: GeoPoint; readonly limit?: number },
  ): Promise<GeoPlace[]>;
  /** The address at a point, if there is one. */
  reverse(point: GeoPoint): Promise<GeoPlace | undefined>;
  /** Places with one of `tags` (`key:value`) within `radiusKm` of `near`, nearest first. */
  nearby(
    tags: readonly string[],
    near: GeoPoint,
    radiusKm: number,
    limit: number,
  ): Promise<GeoPlace[]>;
  route(from: GeoPoint, to: GeoPoint, mode: TravelMode): Promise<GeoRoute>;
};

/** The service isn't there: not set up on this server, still downloading, or stopped. */
export class GeoUnavailable extends Error {
  override name = "GeoUnavailable";
}

let current: Geo | undefined;

/** Makes `geo` the service extensions use on this host; undefined takes it away. */
export function provideGeo(geo: Geo | undefined): void {
  current = geo;
}

/** The host's geo service, if it has one. */
export function providedGeo(): Geo | undefined {
  return current;
}

/** Metres between two points along the earth's surface. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
