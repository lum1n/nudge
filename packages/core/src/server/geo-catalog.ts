import type { GeoPoint } from "../geo/geo.ts";
import { GEO_SOURCES } from "./geo-sources.ts";

/**
 * The world as the server's map can hold it (ADR 18): Geofabrik's regions, from continents down to
 * countries and the states and provinces of the large ones, each with its outline and its roads
 * as one file. Addresses come from the Photon dump that holds the region's country
 * (`geo-sources.ts`), cut to the region's outline.
 */

/** One of Geofabrik's regions. */
export type GeoRegion = {
  /** Such as `norway`, `us/california` or `bayern`. */
  readonly id: string;
  readonly name: string;
  readonly parent?: string;
  /** Its roads, as an OpenStreetMap extract (`.osm.pbf`), with a `.md5` beside it. */
  readonly pbf: string;
  /** The countries it is in, as ISO 3166-1 codes. */
  readonly countries: readonly string[];
  /** Its outline: polygons of rings of `[longitude, latitude]`. */
  readonly outline: readonly (readonly (readonly [number, number])[])[][];
  /** West, south, east, north. */
  readonly bbox: readonly [number, number, number, number];
};

/** A Photon dump: the addresses of a country or a few, published by GraphHopper. */
export type GeoSource = {
  readonly path: string;
  readonly countries: readonly string[];
  readonly bytes: number;
};

export const PHOTON_DUMPS = "https://download1.graphhopper.com/public";
export const GEOFABRIK_INDEX = "https://download.geofabrik.de/index-v1.json";

/** Regions Geofabrik gives no country code, by id; their parts inherit it. */
const COUNTRIES: Readonly<Record<string, readonly string[]>> = {
  "great-britain": ["GB"],
  "britain-and-ireland": ["GB", "IE", "IM"],
  "isle-of-man": ["IM"],
  "guernsey-jersey": ["GG", "JE"],
  kosovo: ["XK"],
  azores: ["PT"],
  "canary-islands": ["ES"],
  comores: ["KM"],
  "south-africa-and-lesotho": ["ZA", "LS"],
  alps: ["AT", "CH", "DE", "FR", "IT", "LI", "SI"],
  dach: ["AT", "CH", "DE"],
  sea: ["BN", "ID", "KH", "LA", "MM", "MY", "PH", "SG", "TH", "TL", "VN"],
};

type GeofabrikFeature = {
  properties: {
    id: string;
    name: string;
    parent?: string;
    urls?: { pbf?: string };
    "iso3166-1:alpha2"?: string[];
    "iso3166-2"?: string[];
  };
  geometry?: { type: string; coordinates: unknown } | null;
};

/** Geofabrik's `index-v1.json` as regions. */
export function parseGeofabrik(index: unknown): GeoRegion[] {
  const features = (index as { features?: GeofabrikFeature[] }).features ?? [];
  const byId = new Map(features.map((f) => [f.properties.id, f.properties]));
  const countriesOf = (id: string): string[] => {
    for (
      let p = byId.get(id);
      p !== undefined;
      p = p.parent === undefined ? undefined : byId.get(p.parent)
    ) {
      if (p["iso3166-1:alpha2"]?.length) return p["iso3166-1:alpha2"];
      const sub = p["iso3166-2"]?.map((code) => code.split("-")[0]!);
      if (sub?.length) return [...new Set(sub)];
      const known = COUNTRIES[p.id];
      if (known !== undefined) return [...known];
    }
    return [];
  };
  const regions: GeoRegion[] = [];
  for (const feature of features) {
    const { id, name, parent, urls } = feature.properties;
    const geometry = feature.geometry;
    if (urls?.pbf === undefined || geometry == null) continue;
    const outline = (
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates
          : []
    ) as [number, number][][][];
    let west = 180;
    let south = 90;
    let east = -180;
    let north = -90;
    for (const polygon of outline)
      for (const ring of polygon)
        for (const [lon, lat] of ring) {
          west = Math.min(west, lon);
          east = Math.max(east, lon);
          south = Math.min(south, lat);
          north = Math.max(north, lat);
        }
    regions.push({
      id,
      name: readable(name),
      ...(parent === undefined ? {} : { parent }),
      pbf: urls.pbf,
      countries: countriesOf(id),
      outline,
      bbox: [west, south, east, north],
    });
  }
  return regions;
}

/** Geofabrik names American states by their ids: `us/rhode-island` → "Rhode Island". */
function readable(name: string): string {
  if (!name.includes("/")) return name;
  return name
    .split("/")
    .at(-1)!
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Whether `point` is inside the region's outline (even-odd over every ring, so holes count). */
export function contains(region: Pick<GeoRegion, "outline" | "bbox">, point: GeoPoint): boolean {
  const { longitude: x, latitude: y } = point;
  const [west, south, east, north] = region.bbox;
  if (x < west || x > east || y < south || y > north) return false;
  let inside = false;
  for (const polygon of region.outline)
    for (const ring of polygon)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!;
        const [xj, yj] = ring[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
  return inside;
}

/** The regions `point` is in, largest first (a continent, its country, a state). */
export function regionsAt(regions: readonly GeoRegion[], point: GeoPoint): GeoRegion[] {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const depth = (region: GeoRegion) => {
    let n = 0;
    for (let p = region.parent; p !== undefined; p = byId.get(p)?.parent) n++;
    return n;
  };
  return regions.filter((region) => contains(region, point)).sort((a, b) => depth(a) - depth(b));
}

/**
 * The region to fetch for `point`: the largest one it is in whose roads take at most `maxBytes`,
 * so a city's surroundings and its country's roads come together where that fits (Norway, or
 * Bavaria rather than all of Germany); else the smallest. Continents are never taken.
 */
export async function regionFor(
  regions: readonly GeoRegion[],
  point: GeoPoint,
  sizeOf: (region: GeoRegion) => Promise<number | undefined>,
  maxBytes: number,
): Promise<GeoRegion | undefined> {
  const candidates = regionsAt(regions, point).filter(
    (region) => region.parent !== undefined && region.countries.length > 0,
  );
  for (const region of candidates) {
    const bytes = await sizeOf(region);
    if (bytes !== undefined && bytes <= maxBytes) return region;
  }
  return candidates.at(-1);
}

/** The Photon dumps that hold a region's countries; empty when none does. */
export function sourcesFor(region: Pick<GeoRegion, "countries">): GeoSource[] {
  const sources: GeoSource[] = [];
  for (const country of region.countries) {
    const holding = Object.entries(GEO_SOURCES)
      .filter(([, source]) => source.countries.includes(country))
      // The smallest that holds it: Ireland's own rather than the British Isles'.
      .sort(([, a], [, b]) => a.bytes - b.bytes)[0];
    if (holding !== undefined && !sources.some((s) => s.path === holding[0]))
      sources.push({ path: holding[0], ...holding[1] });
  }
  return sources;
}

/** Where a Photon dump is downloaded from. */
export function dumpUrl(source: Pick<GeoSource, "path">): string {
  const name = source.path.split("/").at(-1)!;
  return `${PHOTON_DUMPS}/${source.path}/photon-dump-${name}-1.0-latest.jsonl.zst`;
}

const CENTROID = /"centroid":\[(-?[\d.]+),(-?[\d.]+)\]/;

/**
 * Which of `regions` a line of a Photon dump belongs in, by its place's centroid; none for lines
 * that aren't places or are outside them all. By outline rather than country, so places by a
 * border, such as Northern Ireland's in Ireland's region, come along. Read without parsing the
 * JSON, as dumps run to millions of lines.
 */
export function placeRegions(
  line: string,
  regions: readonly Pick<GeoRegion, "id" | "outline" | "bbox">[],
): string[] {
  const centroid = CENTROID.exec(line);
  if (centroid === null) return [];
  const point = { longitude: Number(centroid[1]), latitude: Number(centroid[2]) };
  return regions.filter((region) => contains(region, point)).map((region) => region.id);
}
