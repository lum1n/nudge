import type { UiBlock } from "@nudge/client";
import { m } from "./i18n/index.ts";

type MapBlock = Extract<UiBlock, { type: "map" }>;
type Point = { lat: number; lon: number };

/**
 * Where the app's map comes from: OpenStreetMap's own tiles. The card gives coordinates only, so
 * what loads is always this, and only the area around them (ADR 29).
 */
const TILES = "https://tile.openstreetmap.org";
const TILE = 256;
const WIDTH = 480;
const HEIGHT = 240;
const PAD = 28;

/** A card's map: OpenStreetMap tiles around its markers and path, with each marker numbered. */
export function CardMap(props: { block: MapBlock }) {
  const markers = props.block.markers ?? [];
  const path = props.block.path ?? [];
  const view = fit([...markers, ...path], WIDTH, HEIGHT);
  const center = unproject(view.center);
  return (
    <figure className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full rounded border border-stone-200 bg-stone-100"
        role="img"
        aria-label={markers.map((marker) => marker.label).join(", ") || m.room.chat.card.map}
      >
        {view.tiles.map((tile) => (
          <image
            key={`${tile.x}/${tile.y}`}
            href={`${TILES}/${view.zoom}/${tile.wrapped}/${tile.y}.png`}
            x={tile.left}
            y={tile.top}
            width={TILE}
            height={TILE}
          />
        ))}
        {path.length > 1 &&
          // A white edge under the line keeps it clear of the roads beneath.
          ["white", "#2a78d6"].map((stroke, index) => (
            <polyline
              key={stroke}
              points={path.map((point) => view.at(point).join(",")).join(" ")}
              fill="none"
              stroke={stroke}
              strokeWidth={index === 0 ? 6 : 3}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
        {markers.map((marker, index) => {
          const [x, y] = view.at(marker);
          return (
            <g key={index}>
              <title>{marker.label}</title>
              <circle cx={x} cy={y} r={10} fill="#2a78d6" stroke="white" strokeWidth={2} />
              <text
                x={x}
                y={y}
                dy="0.35em"
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fill="white"
              >
                {index + 1}
              </text>
            </g>
          );
        })}
        <text x={WIDTH - 4} y={HEIGHT - 4} textAnchor="end" fontSize={9} fill="#44403c">
          © OpenStreetMap
        </text>
      </svg>
      <figcaption className="flex flex-col gap-0.5">
        {markers.length > 1 && (
          <ol className="flex flex-col gap-0.5">
            {markers.map((marker, index) => (
              <li key={index} className="flex gap-2">
                <span className="w-4 text-right text-stone-500">{index + 1}</span>
                {marker.label}
              </li>
            ))}
          </ol>
        )}
        {markers.length === 1 && <span>{markers[0]!.label}</span>}
        <a
          className="text-xs text-sky-700 underline"
          target="_blank"
          rel="noreferrer"
          href={`https://www.openstreetmap.org/?mlat=${center.lat.toFixed(5)}&mlon=${center.lon.toFixed(5)}#map=${view.zoom}/${center.lat.toFixed(5)}/${center.lon.toFixed(5)}`}
        >
          {m.room.chat.card.openMap}
        </a>
      </figcaption>
    </figure>
  );
}

/** Where a place lies on the world map, from 0 to 1 each way (Web Mercator). */
function project(point: Point): [number, number] {
  const lat = (Math.max(-85.05, Math.min(85.05, point.lat)) * Math.PI) / 180;
  return [(point.lon + 180) / 360, (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2];
}

function unproject([x, y]: [number, number]): Point {
  return {
    lon: x * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
  };
}

/**
 * The closest zoom that holds every point in a `width` by `height` view, how to place a point in
 * it, and the tiles that cover it.
 */
function fit(points: readonly Point[], width: number, height: number) {
  const projected = points.map(project);
  const xs = projected.map(([x]) => x);
  const ys = projected.map(([, y]) => y);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const center: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
  let zoom = 15;
  while (
    zoom > 0 &&
    ((maxX - minX) * TILE * 2 ** zoom > width - 2 * PAD ||
      (maxY - minY) * TILE * 2 ** zoom > height - 2 * PAD)
  )
    zoom--;
  const scale = TILE * 2 ** zoom;
  const left = center[0] * scale - width / 2;
  const top = center[1] * scale - height / 2;
  const count = 2 ** zoom;
  const tiles = [];
  for (let y = Math.floor(top / TILE); y <= Math.floor((top + height) / TILE); y++) {
    if (y < 0 || y >= count) continue;
    for (let x = Math.floor(left / TILE); x <= Math.floor((left + width) / TILE); x++)
      tiles.push({
        x,
        y,
        wrapped: ((x % count) + count) % count,
        left: x * TILE - left,
        top: y * TILE - top,
      });
  }
  return {
    zoom,
    center,
    tiles,
    at(point: Point): [number, number] {
      const [x, y] = project(point);
      return [x * scale - left, y * scale - top];
    },
  };
}
