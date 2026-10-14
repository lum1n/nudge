import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeOperation, fetchSpec, searchOperations } from "../src/openapi.ts";
import { fixture, start } from "./fixture.ts";

const SPEC = {
  openapi: "3.0.0",
  paths: {
    "/forecast": {
      get: {
        summary: "Get a weather forecast",
        operationId: "getForecast",
        parameters: [
          { name: "lat", in: "query", required: true, schema: { type: "number" } },
          { name: "lon", in: "query", required: true, schema: { type: "number" } },
        ],
      },
    },
    "/alerts": {
      post: {
        summary: "Create an alert",
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Alert" } } },
        },
      },
    },
  },
  components: {
    schemas: { Alert: { type: "object", properties: { message: { type: "string" } } } },
  },
};

describe("searchOperations", () => {
  it("matches on method, path, summary or operationId, every word required", () => {
    expect(searchOperations(SPEC, "forecast")).toEqual([
      "GET /forecast — Get a weather forecast — lat, lon",
    ]);
    expect(searchOperations(SPEC, "weather forecast")).toHaveLength(1);
    expect(searchOperations(SPEC, "weather alert")).toEqual([]);
    expect(searchOperations(SPEC, "")).toHaveLength(2);
  });
});

describe("describeOperation", () => {
  it("resolves $ref in a request body schema", () => {
    const described = describeOperation(SPEC, "post", "/alerts");
    expect(described).toContain("POST /alerts");
    expect(described).toContain("body: object { message }");
  });

  it("describes query parameters, required marked", () => {
    const described = describeOperation(SPEC, "GET", "/forecast");
    expect(described).toContain("- query lat (required): number");
  });

  it("is undefined for an operation that doesn't exist", () => {
    expect(describeOperation(SPEC, "get", "/nope")).toBeUndefined();
  });
});

describe("fetchSpec", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = fixture();
    base = await start(server);
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("fetches and parses a JSON spec", async () => {
    const spec = await fetchSpec(`${base}/openapi.json`);
    expect(searchOperations(spec, "forecast")).toHaveLength(1);
  });

  it("caches the spec, and falls back to the cache when the fetch fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-openapi-"));
    const temp = fixture();
    const tempBase = await start(temp);
    const url = `${tempBase}/openapi.json`;
    await fetchSpec(url, dir);
    await new Promise<void>((resolve) => temp.close(() => resolve()));
    const spec = await fetchSpec(url, dir);
    expect(searchOperations(spec, "forecast")).toHaveLength(1);
  });

  it("refuses a non-JSON body", async () => {
    await expect(fetchSpec(`${base}/text`)).rejects.toThrow(/not JSON/);
  });
});
