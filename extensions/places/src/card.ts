import type { UiCard } from "@nudge/core";
import type { SavedPlace } from "./model.ts";

/** Most markers a map takes. */
const MAX_MARKERS = 20;

/** A map of the places someone saved, for `list_places`. Undefined when there are none. */
export function placesCard(places: readonly SavedPlace[]): UiCard | undefined {
  if (places.length === 0) return undefined;
  const shown = places.slice(0, MAX_MARKERS);
  return {
    v: 1,
    title: "Saved places",
    blocks: [
      {
        type: "map",
        markers: shown.map((place) => ({
          lat: place.latitude,
          lon: place.longitude,
          label: place.name,
        })),
      },
      {
        type: "list",
        items: shown.map((place) => ({
          title: place.name,
          subtitle: `Within ${place.radius} m`,
        })),
      },
    ],
  };
}
