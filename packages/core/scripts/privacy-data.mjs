// Writes the lists the privacy detectors use to src/privacy/lists/: Norwegian place names (SSB
// kommuner and tettsteder, Entur rail stations), top-level domains (IANA), public suffixes
// (publicsuffix.org), well-known public domains (Tranco) and well-known public names (Wikidata,
// through QLever). Run again to refresh, all lists or some:
//   node packages/core/scripts/privacy-data.mjs [--only places,domains,public]
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

const QLEVER = "https://qlever.dev/api/wikidata";
const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
`;

/**
 * The nb, nn and en names and aliases of the items `where` finds (or `langs` and `properties`),
 * one query each: QLever stops at 30 s.
 */
async function sparql(
  where,
  langs = ["en", "nb", "nn"],
  properties = ["rdfs:label", "skos:altLabel"],
) {
  const names = [];
  for (const property of properties)
    for (const lang of langs)
      for (const name of await select(`SELECT DISTINCT ?name WHERE {
  ${where}
  ?i ${property} ?l . FILTER(LANG(?l) = "${lang}")
  BIND(STR(?l) AS ?name)
}`))
        names.push(name);
  return names;
}

async function select(body) {
  const query = PREFIXES + body;
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(QLEVER, {
      method: "POST",
      headers: {
        "user-agent": "nudge-privacy-data (https://github.com/lum1n/nudge)",
        accept: "text/tab-separated-values",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ query }),
    });
    // A public endpoint: it asks to slow down now and then.
    if (response.status !== 429 || attempt === 5) break;
    await new Promise((resolve) => setTimeout(resolve, 15_000 * (attempt + 1)));
  }
  if (!response.ok) throw new Error(`${QLEVER}: ${response.status} ${await response.text()}`);
  return (
    (await response.text())
      .split("\n")
      .slice(1)
      .map((line) => line.trim().replace(/^"|"$/g, ""))
      // "Kiwi (dagligvarekjede)" is called "Kiwi".
      .map((name) => name.replace(/\s*\([^)]*\)$/u, "").trim())
      .filter(Boolean)
  );
}

/** Given names in use in Norway, and family names that 200 people or more have (SSB). */
async function ssbNamesInUse() {
  const names = [];
  for (const table of [10501, 12891]) {
    const { variables } = await (await get(`https://data.ssb.no/api/v0/no/table/${table}`)).json();
    names.push(...variables[0].valueTexts);
  }
  return names;
}

const isA = (cls) => `?i wdt:P31/wdt:P279* wd:${cls}`;
const anyOf = (classes) => classes.map((cls) => `{ ${isA(cls)} }`).join(" UNION ");

/**
 * Names of people, companies, brands, media and landmarks so well known that hiding them only
 * hurts: famous people's full names (40 Wikipedia languages, or 12 for Norwegians), and companies,
 * brands, products, programmes, sites, venues and attractions (2 languages in Norway, 15
 * elsewhere). Schools, kindergartens, small sports clubs, settlements and streets are left out,
 * as are people's single names, single words that are someone's given or family name, and common
 * given and family names together. Apart: countries, and cities of 100,000 or more outside Norway.
 */
async function publicNames() {
  const { FIRST_NAMES, LAST_NAMES } = await import("../src/privacy/name-lists.ts");
  const { NORWEGIAN_PLACES } = await import("../src/privacy/lists/places.ts");
  const first = new Set(FIRST_NAMES);
  const last = new Set(LAST_NAMES);
  // Every Norwegian settlement and area, also former ones ("Hobøl"), stays hidden.
  const areas = await sparql(`?i wdt:P17 wd:Q20 .
    { ${isA("Q486972")} } UNION { ${isA("Q56061")} } UNION { ${isA("Q79007")} }`);
  const places = new Set([...NORWEGIAN_PLACES, ...areas].map((name) => name.toLowerCase()));
  const norwegianPlaces = new Set(NORWEGIAN_PLACES.map((name) => name.toLowerCase()));
  // A single word that is a given name anywhere, or a family name common in Norway ("Ida",
  // "Rose", "Aas"), may be anyone. Rare family names ("Tesla", "Telia") don't count.
  const given = await sparql(
    `{ ?i wdt:P31 wd:Q202444 } UNION { ?i wdt:P31 wd:Q12308941 } UNION { ?i wdt:P31 wd:Q11879590 } UNION { ?i wdt:P31 wd:Q3409032 }`,
    ["mul", "en", "nb"],
  );
  const names = new Set(
    [...given, ...(await ssbNamesInUse()), ...FIRST_NAMES, ...LAST_NAMES].map((name) =>
      name.toLowerCase(),
    ),
  );
  const people = [
    // Aliases only for Norwegians: the rest would double the list for names seldom written here.
    ...(await sparql(
      `?i wdt:P31 wd:Q5 . ?i wikibase:sitelinks ?n . FILTER(?n >= 40)`,
      ["en", "nb"],
      ["rdfs:label"],
    )),
    ...(await sparql(
      `?i wdt:P31 wd:Q5 . ?i wdt:P27 wd:Q20 . ?i wikibase:sitelinks ?n . FILTER(?n >= 12)`,
    )),
  ];
  const norwegian = await sparql(`{ ?i wdt:P17 wd:Q20 } UNION { ?i wdt:P495 wd:Q20 } .
    ?i wikibase:sitelinks ?n . FILTER(?n >= 2)
    ${anyOf(["Q43229", "Q431289", "Q167270", "Q15416", "Q35127", "Q570116", "Q1248784", "Q33506", "Q11315", "Q483110"])}
    MINUS { ${isA("Q2385804")} } MINUS { ${isA("Q486972")} } MINUS { ${isA("Q79007")} }
    MINUS { ${isA("Q847017")} . FILTER(?n < 10) }`);
  const global = await sparql(
    `?i wikibase:sitelinks ?n . FILTER(?n >= 15)
    ${anyOf(["Q4830453", "Q431289", "Q167270", "Q15416", "Q5398426", "Q35127", "Q7397", "Q3231690", "Q476028", "Q46970", "Q1002697", "Q2424752", "Q620615"])}`,
    ["en", "nb"],
  );
  // Countries, and cities of 100,000 or more outside Norway: "London", "Gdańsk", "Norge".
  const world = await sparql(`{ ?i wdt:P31 wd:Q6256 } UNION { ?i wdt:P31 wd:Q3624078 } UNION {
    ?i wdt:P31/wdt:P279* wd:Q515 . ?i wdt:P1082 ?people . FILTER(?people >= 100000)
    MINUS { ?i wdt:P17 wd:Q20 } }`);
  const usable = (name) =>
    name.length >= 2 &&
    // "DA", "IL" and "AS" are what a company or club is, not its name.
    !/^\p{Lu}{2}$/u.test(name) &&
    name.split(" ").length <= 5 &&
    /\p{Lu}/u.test(name) &&
    /^[\p{L}\p{N} .&'’+-]+$/u.test(name) &&
    !places.has(name.toLowerCase()) &&
    (name.includes(" ") || !names.has(name.toLowerCase()));
  const person = (name) => {
    const words = name.split(" ");
    // "Ole Hansen" may be anyone; "Jonas Gahr Støre" is one person.
    return words.length >= 2 && !(words.length === 2 && first.has(words[0]) && last.has(words[1]));
  };
  console.log(
    `people ${people.filter((name) => usable(name) && person(name)).length}, norwegian ${norwegian.filter(usable).length}, global ${global.filter(usable).length}`,
  );
  return {
    names: [
      ...people.filter((name) => usable(name) && person(name)),
      ...[...norwegian, ...global].filter(usable),
    ],
    // May also be a family name ("Paris"), so they count only where the model saw a place.
    places: world.filter(
      (name) => /^\p{Lu}/u.test(name) && !norwegianPlaces.has(name.toLowerCase()),
    ),
  };
}

const sorted = (values) => [...new Set(values)].filter((v) => v.length >= 2).sort();
const list = (name, doc, values) =>
  `/** ${doc} */\nexport const ${name}: readonly string[] = \`\n${sorted(values).join("\n")}\n\`\n  .trim()\n  .split("\\n");\n`;

const only = process.argv.includes("--only")
  ? new Set(process.argv[process.argv.indexOf("--only") + 1].split(","))
  : new Set(["places", "domains", "public"]);
await mkdir(out, { recursive: true });
const header = "// Made by packages/core/scripts/privacy-data.mjs; don't edit by hand.\n\n";

if (only.has("places")) {
  const [kommuner, tettsteder, rail] = await Promise.all([
    ssbNames(131),
    ssbNames(110),
    stations(),
  ]);
  const places = [...kommuner, ...tettsteder, ...rail];
  await writeFile(
    join(out, "places.ts"),
    header +
      list(
        "NORWEGIAN_PLACES",
        "Norwegian kommuner, tettsteder and rail stations (SSB, Entur).",
        places,
      ),
  );
  console.log(`places ${sorted(places).length}`);
}

if (only.has("domains")) {
  const [tld, psl, top] = await Promise.all([tlds(), suffixes(), topDomains()]);
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
  console.log(`tlds ${tld.length}, suffixes ${psl.length}, domains ${top.length}`);
}

if (only.has("public")) {
  const { names, places } = await publicNames();
  await writeFile(
    join(out, "public-names.ts"),
    header +
      list(
        "PUBLIC_NAMES",
        "Well-known people, companies, brands, media and landmarks (Wikidata), which stay readable.",
        names,
      ) +
      "\n" +
      list(
        "PUBLIC_PLACES",
        "Countries, and cities of 100,000 or more outside Norway (Wikidata).",
        places,
      ),
  );
  console.log(`public names ${sorted(names).length}, places ${sorted(places).length}`);
}
