import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkGeo,
  contains,
  distanceMeters,
  graphhopperConfig,
  graphhopperRoute,
  parseGeofabrik,
  photonPlaces,
  placeRegions,
  processFailure,
  regionFor,
  regionsAt,
  ServerGeo,
  sourcesFor,
} from "../src/index.ts";

describe("the map's answers", () => {
  it("reads Photon's places: names, addresses, tags and ids", () => {
    const places = photonPlaces({
      features: [
        {
          geometry: { coordinates: [10.75, 59.915] },
          properties: {
            name: "Kiwi",
            street: "Torggata",
            housenumber: "2",
            postcode: "0181",
            city: "Oslo",
            osm_key: "shop",
            osm_value: "supermarket",
            osm_type: "N",
            osm_id: 42,
          },
        },
        {
          geometry: { coordinates: [10.7461, 59.9127] },
          properties: { street: "Storgata", housenumber: "5", postcode: "0151", city: "Oslo" },
        },
        { properties: { name: "Nowhere" } },
      ],
    });
    expect(places).toEqual([
      {
        latitude: 59.915,
        longitude: 10.75,
        name: "Kiwi",
        address: "Torggata 2, 0181 Oslo",
        city: "Oslo",
        tag: "shop:supermarket",
        id: "N42",
      },
      { latitude: 59.9127, longitude: 10.7461, address: "Storgata 5, 0151 Oslo", city: "Oslo" },
    ]);
  });

  it("reads GraphHopper's route: metres, seconds, and where each turn is", () => {
    const route = graphhopperRoute({
      paths: [
        {
          distance: 1250.4,
          time: 900_000,
          points: {
            coordinates: [
              [10.7461, 59.9127],
              [10.75, 59.913],
              [10.7528, 59.9111],
            ],
          },
          instructions: [
            {
              text: "Continue onto Storgata",
              street_name: "Storgata",
              distance: 300,
              time: 200_000,
              interval: [0, 1],
            },
            {
              text: "Arrive at destination",
              street_name: "",
              distance: 0,
              time: 0,
              interval: [2, 2],
            },
          ],
        },
      ],
    });
    expect(route).toEqual({
      meters: 1250.4,
      seconds: 900,
      steps: [
        {
          text: "Continue onto Storgata",
          street: "Storgata",
          meters: 300,
          seconds: 200,
          at: { latitude: 59.9127, longitude: 10.7461 },
        },
        {
          text: "Arrive at destination",
          meters: 0,
          seconds: 0,
          at: { latitude: 59.9111, longitude: 10.7528 },
        },
      ],
    });
    expect(() => graphhopperRoute({ paths: [] })).toThrow("No way");
  });

  it("measures distances on the earth", () => {
    expect(
      Math.round(
        distanceMeters(
          { latitude: 59.9127, longitude: 10.7461 },
          { latitude: 59.9111, longitude: 10.7528 },
        ),
      ),
    ).toBe(414);
  });

  it("configures GraphHopper for car, bike and foot on localhost only", () => {
    const config = graphhopperConfig({
      pbf: "/d/no.osm.pbf",
      graph: "/d/graph",
      port: 4100,
      adminPort: 4101,
      store: "MMAP",
    });
    expect(config).toContain('datareader.file: "/d/no.osm.pbf"');
    expect(config).toContain("custom_model_files: [bike.json]");
    expect(config).toContain("    - profile: foot");
    expect(config).toContain("graph.dataaccess.default_type: MMAP");
    expect(config.match(/bind_host: 127\.0\.0\.1/g)).toHaveLength(2);
    // GraphHopper 11 refuses to import without it.
    expect(config).toContain('import.osm.ignored_highways: ""');
  });

  it("finds Java's reason in what a process wrote", () => {
    const output = [
      "INFO starting",
      "java.lang.IllegalArgumentException: Missing 'import.osm.ignored_highways'. See config-example.yml",
      "\tat com.graphhopper.GraphHopper.init(GraphHopper.java:576)",
    ].join("\n");
    expect(processFailure(output)).toBe(
      "java.lang.IllegalArgumentException: Missing 'import.osm.ignored_highways'. See config-example.yml",
    );
    expect(processFailure("tar: oops\n")).toBe("tar: oops");
  });
});

/** A small world: squares around Norway, the US and California, Germany and Bavaria, Britain. */
const square = (west: number, south: number, east: number, north: number) => [
  [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ],
];
const feature = (
  id: string,
  parent: string | undefined,
  box: [number, number, number, number],
  codes: { iso?: string[]; sub?: string[] } = {},
) => ({
  properties: {
    id,
    name: id,
    ...(parent === undefined ? {} : { parent }),
    urls: { pbf: `http://127.0.0.1:1/${id}-latest.osm.pbf` },
    ...(codes.iso === undefined ? {} : { "iso3166-1:alpha2": codes.iso }),
    ...(codes.sub === undefined ? {} : { "iso3166-2": codes.sub }),
  },
  geometry: { type: "Polygon", coordinates: square(...box) },
});
const WORLD = {
  features: [
    feature("europe", undefined, [-30, 30, 50, 80]),
    feature("norway", "europe", [4, 57, 31, 72], { iso: ["NO"] }),
    feature("germany", "europe", [5, 47, 15, 55], { iso: ["DE"] }),
    feature("bayern", "germany", [9, 47, 14, 50.5]),
    feature("great-britain", "europe", [-8, 50, 2, 59]),
    feature("england", "great-britain", [-6, 50, 2, 55.8]),
    feature("north-america", undefined, [-170, 10, -50, 80]),
    feature("us", "north-america", [-125, 24, -66, 50], { iso: ["US"] }),
    feature("us/california", "north-america", [-124.5, 32.5, -114, 42], { sub: ["US-CA"] }),
  ],
};

describe("the world's regions", () => {
  const regions = parseGeofabrik(WORLD);
  const OSLO = { latitude: 59.91, longitude: 10.75 };
  const MUNICH = { latitude: 48.14, longitude: 11.58 };
  const LA = { latitude: 34.05, longitude: -118.24 };

  it("gives every region its countries, from its own codes or those it is part of", () => {
    expect(regions.find((r) => r.id === "us/california")?.name).toBe("California");
    const countries = Object.fromEntries(regions.map((r) => [r.id, r.countries]));
    expect(countries).toMatchObject({
      norway: ["NO"],
      bayern: ["DE"],
      england: ["GB"],
      "us/california": ["US"],
      europe: [],
    });
  });

  it("finds the regions a point is in, largest first, holes and all", () => {
    expect(regionsAt(regions, MUNICH).map((r) => r.id)).toEqual(["europe", "germany", "bayern"]);
    expect(regionsAt(regions, LA).map((r) => r.id)).toEqual([
      "north-america",
      "us",
      "us/california",
    ]);
    expect(regionsAt(regions, { latitude: 0, longitude: 0 })).toEqual([]);
    const ring = {
      outline: [[...square(0, 0, 10, 10), ...square(4, 4, 6, 6)]] as [number, number][][][],
      bbox: [0, 0, 10, 10] as const,
    };
    expect(contains(ring, { latitude: 2, longitude: 2 })).toBe(true);
    expect(contains(ring, { latitude: 5, longitude: 5 })).toBe(false);
  });

  it("fetches the largest region that fits, never a continent", async () => {
    const sizes: Record<string, number> = {
      germany: 4e9,
      bayern: 8e8,
      us: 1e10,
      "us/california": 1.2e9,
      norway: 1.4e9,
    };
    const size = async (r: { id: string }) => sizes[r.id];
    expect((await regionFor(regions, MUNICH, size, 1.5e9))?.id).toBe("bayern");
    expect((await regionFor(regions, OSLO, size, 1.5e9))?.id).toBe("norway");
    expect((await regionFor(regions, LA, size, 1.5e9))?.id).toBe("us/california");
    // Nothing fits: the smallest.
    expect((await regionFor(regions, OSLO, size, 1e8))?.id).toBe("norway");
    expect(await regionFor(regions, { latitude: 0, longitude: 0 }, size, 1e9)).toBeUndefined();
  });

  it("takes addresses from the smallest dump that holds the country, cut to the outline", () => {
    expect(sourcesFor({ countries: ["NO"] }).map((s) => s.path)).toEqual(["europe/norway"]);
    expect(sourcesFor({ countries: ["IE"] }).map((s) => s.path)).toEqual(["europe/ireland"]);
    expect(sourcesFor({ countries: ["US"] }).map((s) => s.path)).toEqual(["north-america/usa"]);
    expect(sourcesFor({ countries: ["AQ"] })).toEqual([]);
    const line = (lon: number, lat: number) =>
      `{"type":"Place","content":[{"country_code":"de","centroid":[${lon},${lat}],"name":{"name":"x"}}]}`;
    const germany = regions.filter((r) => r.id === "germany" || r.id === "bayern");
    expect(placeRegions(line(11.58, 48.14), germany).sort()).toEqual(["bayern", "germany"]);
    expect(placeRegions(line(13.4, 52.5), germany)).toEqual(["germany"]);
    expect(placeRegions(line(2.35, 48.85), germany)).toEqual([]);
    expect(placeRegions('{"type":"CountryInfo","content":[]}', germany)).toEqual([]);
  });
});

describe("the server's map", () => {
  it("holds what owners pick and where people are, and says what is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nudge-geo-"));
    try {
      await writeFile(join(dir, "regions.json"), JSON.stringify(WORLD));
      const geo = new ServerGeo({ dir, download: false });
      await geo.load();
      expect(geo.status()).toMatchObject({ state: "off", follow: true, limitGb: 20, regions: [] });
      await expect(geo.geo.search("Oslo S")).rejects.toThrow("The map has no regions yet");
      expect((await geo.available()).map((r) => r.id)).toContain("us/california");
      await expect(geo.configure({ regions: ["atlantis"] })).rejects.toThrow(
        'No region "atlantis"',
      );

      expect(await geo.configure({ regions: ["norway"], limitGb: 10 })).toMatchObject({
        state: "working",
        limitGb: 10,
        regions: [{ id: "norway", by: "owner", state: "waiting" }],
      });
      // Someone in Munich: Bavaria follows them (no sizes known here, so the smallest).
      expect(await geo.follow({ latitude: 48.14, longitude: 11.58 })).toBe("fetching");
      expect(await geo.follow({ latitude: 48.2, longitude: 11.6 })).toBe("fetching");
      expect(geo.status().regions.map((r) => [r.id, r.by])).toEqual([
        ["norway", "owner"],
        ["bayern", "follow"],
      ]);
      // In the middle of the ocean there is nothing to fetch.
      expect(await geo.follow({ latitude: 0, longitude: -30 })).toBe("outside");
      await geo.configure({ follow: false });
      expect(await geo.follow({ latitude: 34.05, longitude: -118.24 })).toBe("outside");
      // Owners' picks go when they unpick them; regions that followed someone stay.
      await geo.configure({ regions: [] });
      expect(geo.status().regions.map((r) => r.id)).toEqual(["bayern"]);
      await geo.close();

      expect(await checkGeo(dir)).toEqual([
        "The map of bayern isn't ready yet: it downloads while the server runs",
      ]);
      const saved = JSON.parse(await readFile(join(dir, "geo.json"), "utf8"));
      saved.regions.bayern.installed = { at: 1, photon: {}, osm: "x", bytes: 1 };
      await writeFile(join(dir, "geo.json"), JSON.stringify(saved));
      expect(await checkGeo(dir)).toEqual([
        "The map is missing the roads of bayern; pick the region again to fetch them",
        "The map is missing its Java; pick a region again to fetch it",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
