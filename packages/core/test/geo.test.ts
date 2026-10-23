import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkGeo,
  distanceMeters,
  graphhopperConfig,
  graphhopperRoute,
  photonPlaces,
  processFailure,
  ServerGeo,
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

describe("the server's map", () => {
  it("is off until a region is picked, refuses unknown ones, and says what is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nudge-geo-"));
    try {
      const geo = new ServerGeo({ dir });
      await geo.load();
      expect(geo.status()).toMatchObject({
        state: "off",
        regions: expect.arrayContaining([{ code: "no", name: "Norway" }]),
      });
      await expect(geo.setRegion("atlantis")).rejects.toThrow('No region "atlantis"');
      await expect(geo.geo.search("Oslo S")).rejects.toThrow("an owner picks a region");
      expect(await checkGeo(dir)).toEqual([]);
      await geo.close();

      // A region picked but not fetched yet, as after a restart mid-download.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "geo.json"), JSON.stringify({ region: "no" }));
      expect(await checkGeo(dir)).toEqual([
        "The map of Norway isn't ready yet: it downloads while the server runs",
      ]);
      await writeFile(
        join(dir, "geo.json"),
        JSON.stringify({ region: "no", installed: { region: "no", at: 1, photon: "a", osm: "b" } }),
      );
      expect((await checkGeo(dir)).length).toBe(5);
      expect(JSON.parse(await readFile(join(dir, "geo.json"), "utf8")).region).toBe("no");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
