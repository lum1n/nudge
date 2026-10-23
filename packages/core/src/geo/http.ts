import type { Geo, GeoPlace, GeoPoint, GeoRoute, TravelMode } from "./geo.ts";
import { GeoUnavailable } from "./geo.ts";

/** Where the two services listen; each started when first asked for. */
export type GeoEndpoints = {
  /** Photon's address, such as `http://127.0.0.1:41234`. */
  readonly photon: () => Promise<string>;
  /** The address of a GraphHopper whose roads join `from` and `to`. */
  readonly graphhopper: (from: GeoPoint, to: GeoPoint) => Promise<string>;
};

/** One feature of a Photon answer (GeoJSON). */
type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
    district?: string;
    locality?: string;
    osm_key?: string;
    osm_value?: string;
    osm_type?: string;
    osm_id?: number;
    type?: string;
  };
};

/** Photon's GeoJSON as places: "Storgata 5, 0151 Oslo" for the address, the tag as `key:value`. */
export function photonPlaces(answer: unknown): GeoPlace[] {
  const features = (answer as { features?: PhotonFeature[] } | undefined)?.features ?? [];
  const places: GeoPlace[] = [];
  for (const feature of features) {
    const [longitude, latitude] = feature.geometry?.coordinates ?? [];
    if (typeof latitude !== "number" || typeof longitude !== "number") continue;
    const p = feature.properties ?? {};
    const street = [p.street, p.housenumber].filter(Boolean).join(" ");
    const town = [p.postcode, p.city ?? p.locality ?? p.district].filter(Boolean).join(" ");
    const address = [street, town].filter((part) => part !== "").join(", ");
    // A plain house has its address as its name; Photon then leaves the name out.
    const named = p.name !== undefined && p.name !== street;
    places.push({
      latitude,
      longitude,
      ...(named ? { name: p.name } : {}),
      ...(street === "" ? {} : { address }),
      ...(p.city === undefined ? {} : { city: p.city }),
      ...(p.osm_key === undefined || p.osm_value === undefined
        ? {}
        : { tag: `${p.osm_key}:${p.osm_value}` }),
      ...(p.osm_type === undefined || p.osm_id === undefined
        ? {}
        : { id: `${p.osm_type}${p.osm_id}` }),
    });
  }
  return places;
}

/** One path of a GraphHopper `/route` answer, with `points_encoded=false`. */
type GraphHopperPath = {
  distance?: number;
  time?: number;
  points?: { coordinates?: [number, number][] };
  instructions?: {
    text?: string;
    street_name?: string;
    distance?: number;
    time?: number;
    interval?: [number, number];
  }[];
};

/** GraphHopper's first path as a route: metres, seconds and the turns, each where it starts. */
export function graphhopperRoute(answer: unknown): GeoRoute {
  const path = (answer as { paths?: GraphHopperPath[] } | undefined)?.paths?.[0];
  if (path === undefined) throw new Error("No way between those places");
  const points = path.points?.coordinates ?? [];
  return {
    meters: path.distance ?? 0,
    seconds: (path.time ?? 0) / 1000,
    steps: (path.instructions ?? []).flatMap((step) => {
      const [longitude, latitude] = points[step.interval?.[0] ?? 0] ?? [];
      if (latitude === undefined || longitude === undefined) return [];
      return [
        {
          text: step.text ?? "",
          ...(step.street_name ? { street: step.street_name } : {}),
          meters: step.distance ?? 0,
          seconds: (step.time ?? 0) / 1000,
          at: { latitude, longitude },
        },
      ];
    }),
  };
}

const PROFILES: Record<TravelMode, string> = { car: "car", bike: "bike", foot: "foot" };

/** The map service over HTTP: Photon for places, GraphHopper for routes. */
export function httpGeo(endpoints: GeoEndpoints, language = "en"): Geo {
  const get = async (base: Promise<string>, path: string, params: URLSearchParams) => {
    const url = `${await base}${path}?${params}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(
      (error: unknown) => {
        throw new GeoUnavailable(`The map service didn't answer: ${(error as Error).message}`);
      },
    );
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = (body as { message?: string } | undefined)?.message;
      throw new Error(message ?? `The map service answered ${response.status}`);
    }
    return body;
  };
  const near = (params: URLSearchParams, point: GeoPoint | undefined) => {
    if (point === undefined) return;
    params.set("lat", String(point.latitude));
    params.set("lon", String(point.longitude));
  };
  return {
    async search(query, options = {}) {
      const params = new URLSearchParams({
        q: query,
        limit: String(options.limit ?? 5),
        lang: language,
      });
      near(params, options.near);
      return photonPlaces(await get(endpoints.photon(), "/api", params));
    },
    async reverse(point) {
      // A house's address, not the road or the district it is on.
      const params = new URLSearchParams({ limit: "1", lang: language, osm_tag: "place:house" });
      near(params, point);
      return photonPlaces(await get(endpoints.photon(), "/reverse", params))[0];
    },
    async nearby(tags, point, radiusKm, limit) {
      const params = new URLSearchParams({
        limit: String(limit),
        radius: String(radiusKm),
        lang: language,
      });
      near(params, point);
      for (const tag of tags) params.append("osm_tag", tag);
      return photonPlaces(await get(endpoints.photon(), "/reverse", params));
    },
    async route(from, to, mode) {
      const params = new URLSearchParams({
        profile: PROFILES[mode],
        points_encoded: "false",
        instructions: "true",
        locale: language,
      });
      params.append("point", `${from.latitude},${from.longitude}`);
      params.append("point", `${to.latitude},${to.longitude}`);
      return graphhopperRoute(await get(endpoints.graphhopper(from, to), "/route", params));
    },
  };
}
