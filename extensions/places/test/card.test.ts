import { cardProblem } from "@nudge/core";
import { describe, expect, it } from "vitest";
import { placesCard } from "../src/card.ts";

const place = (name: string, latitude: number, longitude: number) => ({
  name,
  placeholder: `⟦PLACE:${name}⟧`,
  latitude,
  longitude,
  radius: 100,
  createdAt: 0,
});

describe("placesCard", () => {
  it("puts the saved places on a map", () => {
    const card = placesCard([place("home", 59.9127, 10.7461), place("work", 59.92, 10.76)]);
    expect(cardProblem(card)).toBeUndefined();
    expect(card?.blocks?.[0]).toEqual({
      type: "map",
      markers: [
        { lat: 59.9127, lon: 10.7461, label: "home" },
        { lat: 59.92, lon: 10.76, label: "work" },
      ],
    });
  });

  it("has no card without places, and keeps to 20 markers", () => {
    expect(placesCard([])).toBeUndefined();
    const many = Array.from({ length: 25 }, (_, i) => place(`p${i}`, 59, 10));
    expect(cardProblem(placesCard(many))).toBeUndefined();
  });
});
