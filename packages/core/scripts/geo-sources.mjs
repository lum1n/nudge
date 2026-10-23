// Writes src/server/geo-sources.ts: every Photon dump GraphHopper publishes (the addresses of a
// country or a group of them, for Photon 1.x), with the countries it holds and its size. The server
// takes a region's addresses from the dump that holds its country (ADR 18).
//
//   node packages/core/scripts/geo-sources.mjs
//
// Countries come from Geofabrik's region of the same name; the table below covers the dumps whose
// names differ or that group several countries.
import { writeFile } from "node:fs/promises";

const PUBLIC = "https://download1.graphhopper.com/public";
const CONTINENTS = [
  "europe",
  "asia",
  "north-america",
  "south-america",
  "africa",
  "australia-oceania",
];

const GROUPS = {
  "europe/baltics": ["EE", "LV", "LT"],
  "europe/british-islands": ["GB", "IE", "IM", "GG", "JE"],
  "europe/france-monacco": ["FR", "MC"],
  "europe/iceland-faroe": ["IS", "FO"],
  "europe/ireland": ["IE", "GB"],
  "europe/kosovo": ["XK"],
  "europe/luxemburg": ["LU"],
  "europe/switzerland-liechtenstein": ["CH", "LI"],
  "asia/arabian-peninsula": ["SA", "AE", "OM", "YE", "QA", "KW", "BH"],
  "asia/asia-indian-ocean": ["LK", "MV", "IO", "CC", "CX"],
  "asia/brunei": ["BN"],
  "asia/central-asia": ["KZ", "KG", "TJ", "TM", "UZ"],
  "asia/isreal": ["IL"],
  "asia/korea": ["KR", "KP"],
  "asia/malaysia": ["MY"],
  "asia/palestine": ["PS"],
  "asia/singapore": ["SG"],
  "north-america/caribbean": [
    "AG",
    "AI",
    "AW",
    "BB",
    "BL",
    "BQ",
    "BS",
    "CU",
    "CW",
    "DM",
    "DO",
    "GD",
    "GP",
    "HT",
    "JM",
    "KN",
    "KY",
    "LC",
    "MF",
    "MQ",
    "MS",
    "PR",
    "SX",
    "TC",
    "TT",
    "VC",
    "VG",
    "VI",
  ],
  "north-america/central-america": ["BZ", "CR", "GT", "HN", "NI", "PA", "SV"],
  "north-america/usa": ["US"],
  "south-america/south-america-north": ["VE", "GY", "SR", "GF"],
  "south-america/south-atlantic": ["FK", "GS"],
  "africa/africa-eastern-islands": ["KM", "MG", "MU", "RE", "SC", "YT"],
  "africa/central-africa": ["AO", "CM", "CF", "TD", "CG", "CD", "GQ", "GA", "ST"],
  "africa/horn-of-africa": ["ET", "ER", "DJ", "SO", "SS"],
  "africa/kenia": ["KE"],
  "africa/northern-africa": ["DZ", "EG", "LY", "MA", "TN", "EH", "SD"],
  "africa/saint-helena": ["SH"],
  "africa/southern-africa": ["ZA", "LS", "SZ", "NA", "BW"],
  "africa/western-africa": [
    "BJ",
    "BF",
    "CV",
    "CI",
    "GM",
    "GH",
    "GN",
    "GW",
    "LR",
    "ML",
    "MR",
    "NE",
    "SN",
    "SL",
    "TG",
  ],
  "australia-oceania/oceania": [
    "PG",
    "FJ",
    "SB",
    "VU",
    "NC",
    "PF",
    "WS",
    "TO",
    "KI",
    "FM",
    "MH",
    "PW",
    "NR",
    "TV",
    "CK",
    "NU",
    "NF",
    "AS",
    "GU",
    "MP",
    "WF",
    "TK",
    "PN",
  ],
};

const geofabrik = (
  await (await fetch("https://download.geofabrik.de/index-v1-nogeom.json")).json()
).features.map((f) => f.properties);
const byId = new Map(geofabrik.map((p) => [p.id, p]));
const countriesOf = (id) => {
  for (let p = byId.get(id); p !== undefined; p = byId.get(p.parent))
    if (p["iso3166-1:alpha2"]) return p["iso3166-1:alpha2"];
  return undefined;
};

const sources = {};
for (const continent of CONTINENTS) {
  const html = await (await fetch(`${PUBLIC}/${continent}/index.html`)).text();
  const names = [
    ...new Set(
      [...html.matchAll(new RegExp(`public/${continent}/([a-z0-9-]+)/index.html`, "g"))].map(
        (m) => m[1],
      ),
    ),
  ];
  for (const name of names.sort()) {
    const path = `${continent}/${name}`;
    const countries = GROUPS[path] ?? countriesOf(name);
    if (countries === undefined) throw new Error(`No countries for ${path}: add it to GROUPS`);
    const url = `${PUBLIC}/${path}/photon-dump-${name}-1.0-latest.jsonl.zst`;
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) {
      console.warn(`skipped ${path}: ${head.status}`);
      continue;
    }
    sources[path] = {
      countries: [...countries].sort(),
      bytes: Number(head.headers.get("content-length")),
    };
  }
}
const covered = new Set(Object.values(sources).flatMap((s) => s.countries));
const missing = [...new Set(geofabrik.flatMap((p) => p["iso3166-1:alpha2"] ?? []))].filter(
  (c) => !covered.has(c),
);
if (missing.length > 0)
  console.warn(`Countries Geofabrik has and no dump holds: ${missing.join(" ")}`);
const file = new URL("../src/server/geo-sources.ts", import.meta.url);
const lines = Object.entries(sources).map(
  ([path, { countries, bytes }]) =>
    `  "${path}": { countries: ${JSON.stringify(countries)}, bytes: ${bytes} },`,
);
await writeFile(
  file,
  [
    "// Written by scripts/geo-sources.mjs: GraphHopper's Photon dumps, the countries each holds, and",
    "// its size in bytes. Run it again for new dumps.",
    "export const GEO_SOURCES: Readonly<Record<string, { countries: readonly string[]; bytes: number }>> = {",
    ...lines,
    "};",
    "",
  ].join("\n"),
);
console.log(`${Object.keys(sources).length} dumps, ${covered.size} countries`);
