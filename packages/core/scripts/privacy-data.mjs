// Writes the lists the privacy detectors use to src/privacy/lists/: Norwegian place names (SSB
// kommuner and tettsteder, Entur rail stations), top-level domains (IANA), public suffixes
// (publicsuffix.org) and well-known public domains (Tranco). Run again to refresh:
//   node packages/core/scripts/privacy-data.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "../src/privacy/lists");
const TOP = 10_000;
const TOP_NO = 100_000;

async function get(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": "nudge-privacy-data", ...headers },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}

async function ssbNames(classification) {
  const url = `https://data.ssb.no/api/klass/v1/classifications/${classification}/codes?from=2024-01-01`;
  const { codes } = await (await get(url, { accept: "application/json" })).json();
  // "Aarborte - Hattfjelldal", "Bø i Telemark": every written form counts.
  return codes.flatMap((code) => code.name.split(/ - |\//).map((name) => name.trim()));
}

async function stations() {
  const url =
    "https://api.entur.io/stop-places/v1/read/stop-places?stopPlaceTypes=railStation&count=5000";
  const places = await (
    await get(url, { accept: "application/json", "ET-Client-Name": "nudge-privacy-data" })
  ).json();
  return places.flatMap(({ name: { value } }) => {
    if (value.endsWith(" stasjon")) return [value.slice(0, -" stasjon".length)];
    if (value.endsWith(" S")) return [value];
    return []; // Swedish and other foreign stations
  });
}

async function tlds() {
  const text = await (await get("https://data.iana.org/TLD/tlds-alpha-by-domain.txt")).text();
  return text
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("XN--"))
    .map((line) => line.toLowerCase());
}

async function suffixes() {
  const text = await (await get("https://publicsuffix.org/list/public_suffix_list.dat")).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("!"))
    .filter((line) => line.includes(".") && /^[*a-z0-9.-]+$/.test(line));
}

async function topDomains() {
  const { download } = await (await get("https://tranco-list.eu/api/lists/date/latest")).json();
  const text = await (await get(download.replace(/\d+$/, String(TOP_NO)))).text();
  return text
    .split("\n")
    .map((line) => line.trim().split(",")[1])
    .filter((domain, i) => domain !== undefined && (i < TOP || domain.endsWith(".no")));
}

const sorted = (values) => [...new Set(values)].filter((v) => v.length >= 2).sort();
const list = (name, doc, values) =>
  `/** ${doc} */\nexport const ${name}: readonly string[] = \`\n${sorted(values).join("\n")}\n\`\n  .trim()\n  .split("\\n");\n`;

const [kommuner, tettsteder, rail, tld, psl, top] = await Promise.all([
  ssbNames(131),
  ssbNames(110),
  stations(),
  tlds(),
  suffixes(),
  topDomains(),
]);

await mkdir(out, { recursive: true });
const header = "// Made by packages/core/scripts/privacy-data.mjs; don't edit by hand.\n\n";
await writeFile(
  join(out, "places.ts"),
  header +
    list("NORWEGIAN_PLACES", "Norwegian kommuner, tettsteder and rail stations (SSB, Entur).", [
      ...kommuner,
      ...tettsteder,
      ...rail,
    ]),
);
await writeFile(
  join(out, "domains.ts"),
  header +
    list("TLDS", "Top-level domains (IANA), lower case.", tld) +
    "\n" +
    list("PUBLIC_SUFFIXES", "Public suffixes of two labels or more (publicsuffix.org).", psl) +
    "\n" +
    list(
      "WELL_KNOWN_DOMAINS",
      `The ${TOP} most visited domains, and .no domains in the top ${TOP_NO} (Tranco).`,
      top,
    ),
);
console.log(
  `places ${sorted([...kommuner, ...tettsteder, ...rail]).length}, tlds ${tld.length}, suffixes ${psl.length}, domains ${top.length}`,
);
