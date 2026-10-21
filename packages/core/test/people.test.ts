import { describe, expect, it } from "vitest";
import { addressDetector, nameDetector, type PiiDetector } from "../src/index.ts";

const found = (detector: PiiDetector, text: string) =>
  [...detector.find(text)].map(({ start, end }) => text.slice(start, end));

describe("names", () => {
  const names = nameDetector(["Tiril", "Bestemor Gunn"]);

  it("finds given names, with the family names after them", () => {
    expect(found(names, "Jeg møtte Kari Nordmann i går, og Lars kommer i morgen.")).toEqual([
      "Kari Nordmann",
      "Lars",
    ]);
    expect(found(names, "Grete Waitz løp. Snakk med Anne-Lise Berg-Hansen om det.")).toEqual([
      "Grete Waitz",
      "Anne-Lise Berg-Hansen",
    ]);
    expect(found(names, "Meeting with Elizabeth Warren and Tom.")).toEqual([
      "Elizabeth Warren",
      "Tom",
    ]);
  });

  it("takes everyday words that are names only where they must be names", () => {
    expect(found(names, "Per dag koster det 50 kr. Liv og lære.")).toEqual([]);
    expect(found(names, "Spør Per om det. Per Hansen vet.")).toEqual(["Per", "Per Hansen"]);
  });

  it("finds a family name after a capitalized word, and names after sign-offs and titles", () => {
    expect(found(names, "Boka er av Ivar Aasen.")).toEqual(["Ivar Aasen"]);
    expect(found(names, "Takk for sist!\nMvh\nTorleif Ustrup")).toEqual(["Torleif Ustrup"]);
    expect(found(names, "Timen er hos Dr. Kvammen klokka 9.")).toEqual(["Kvammen"]);
    expect(found(names, "Hilsen Bestemor Gunn og Tiril")).toEqual(["Bestemor Gunn", "Tiril"]);
  });

  it("leaves places and ordinary capitalized words alone", () => {
    expect(found(names, "Været i Oslo blir fint. Rema 1000 stenger 23. Norge vant.")).toEqual([]);
  });
});

describe("addresses", () => {
  it("finds street addresses with postal code and town when they follow", () => {
    expect(
      found(addressDetector, "Jeg bor i Storgata 5B, 0151 Oslo. Hytta er i Fjellveien 12."),
    ).toEqual(["Storgata 5B, 0151 Oslo", "Fjellveien 12"]);
    expect(found(addressDetector, "Kontoret er i Kong Oscars gate 4 i Bergen.")).toEqual([
      "Kong Oscars gate 4",
    ]);
    expect(found(addressDetector, "Veien videre er lang. Oslo og Bergen.")).toEqual([]);
  });
});
