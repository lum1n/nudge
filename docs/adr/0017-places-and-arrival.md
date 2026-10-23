# 17. Places have names in the vault, and reminders fire on arrival

"When I'm at the store, remind me to buy milk" didn't work. Nudges fire at a time, watches on a schedule and triggers on a web call, and the apps only say where someone is while they are open (ADR 14). The `places` extension saves people's places, reminds them when they get to one or leave it, and finds addresses and routes. Where someone lives and where they go must not reach a model provider.

**Named placeholders.** A saved place is in the vault as its owner's value, and its placeholder carries the name they gave it: `⟦PLACE:home⟧`, `⟦PLACE:mums-house⟧`. The model can tell places apart and write sentences people understand. A numbered `⟦PLACE7⟧` says nothing, and listing what each one means would cost a prompt section in every turn.
- The name is lower-case letters, digits and dashes, at most 20 characters. `Vault.protectNamed` makes it, and every placeholder regex (core, federation, the web, Android and Apple) takes both shapes.
- A name another value has gets `-2`, `-3`, …. The extension asks for `bo-home` when Ann has `home`, since players' names are readable (ADR 15).
- A forgotten named placeholder is given back to the same owner, and to nobody else. When someone moves, `⟦PLACE:home⟧` stands for the new home, also in the history where they see it. Numbered placeholders stay append-only.
- A value the vault hides already keeps the placeholder it has. Two people who save the same address share the first one's, which only that person sees. The extension keeps coordinates of its own for each, so arrival and routes work for both.

**Coordinates never reach the model.**
- The extension keeps each place's latitude, longitude and radius in its own document, which no tool returns.
- `find_place` gives names, kinds and distances. Each result gets an owned named placeholder for its street address (`Kiwi (supermarket), 650 m from ⟦PLACE:home⟧: ⟦PLACE:kiwi⟧`). Brands stay readable as organisations do; the street that would tell where someone is doesn't.
- `route` gives time, distance and the turns, but leaves out the steps within 500 m of the person's own places and where they are. The way home doesn't spell out the street.
- What someone typed to save a place ("Storgata 5") is hidden as their value too, so the next request has it as a placeholder even in the message that gave it.

**Arrival is seen on the phone, and checked on the server.**
- **On the phone.** The apps register OS geofences, which wake them in the background. The places come from `GET /ext/places/regions`, which lists the saved places that have reminders. For reminders by kind ("any grocery store"), the server asks the map for the nearest few around the position the phone gives, up to `regions` (19 by default; an iPhone watches 20). It also returns a refresh circle: leaving it makes the phone ask again. The phone posts `enter` and `exit` to `/ext/places/events`.
- **On the server.** A new core hook, `ExtensionParts.onLocation`, hears every location an app or the web sends, as it was sent, before the 100 m rounding of ADR 14. The extension checks the person's places against it. That covers the foreground app and the web without a geofence. Both ways land in the same check: a `once` reminder is gone after it fires, and an `always` one waits an hour. `maxPerHour` caps them per person.
- The position the phone sends to `/regions` is used for that lookup and not kept. These routes answer only on the person's home assistant, where ADR 14 keeps their location; elsewhere they are a 403.

**A reminder is private unless the room may know where they are.** An arrival fires as a nudge does (`FIRE_ENTRY`, `source: "arrival"`, shown as a nudge). "Ann just got home" tells a room where Ann is. So in a shared room it is private to her unless she lets the model know where she is there (ADR 14's consent). Her personal room has no such limit. The places section follows the same rules: her places and reminders in her personal room and private turns, and only "Ann is at their home" and her open reminders in a shared room she shares her location with.

**The map is the server's own, and follows people anywhere in the world.** Addresses and routes come from Photon (geocoding, and search by OpenStreetMap tag around a point) and GraphHopper (car, bike and foot), both single Java jars that the server runs on a JRE it downloads. Asking a public geocoder would tell it every address people save and every route they ask for. So nothing is asked outside, ever; only map data comes in.

- **The whole planet won't fit, so the map holds regions.** It would need about 95 GB of addresses, 80 GB of roads and 64 GB of memory to import. A region is one of Geofabrik's 554, from countries down to the states and provinces of large ones. Their outlines come from Geofabrik's index, fetched and kept by the server.
- **A region's roads** are its own OpenStreetMap extract and a graph of its own. A route needs a region that holds both ends, the smallest one if there are several. Each region's router starts when it is asked for and stops when idle.
- **A region's addresses** come from GraphHopper's Photon dump that holds its country: 115 dumps, 236 countries (`geo-sources.ts`, written by `scripts/geo-sources.mjs`). The dump is cut to the region's outline as it streams in, so California doesn't keep the whole of the US. The addresses of all regions are imported into one Photon database.
- **Owners pick regions, and the map follows people.** Every location an app sends goes to the map (`Geo.follow`). When no region holds it, the server fetches the largest region around that point whose roads take at most 1.5 GB: Norway, or Bavaria rather than all of Germany. A trip abroad is ready within minutes to an hour. Regions fetched this way are dropped, the longest unused first, when the map would pass its disk limit (20 GB by default). Regions owners picked are never dropped, and one bigger than the limit by itself fails.
- **Outside the map, the tools say so.** They say the region is being fetched, or that it won't be. They never ask anyone else.

The extension talks to the map through a small `Geo` interface (`provideGeo`). Hosts without one, such as Cloudflare, keep saved places and arrival reminders, which need no search.

What this doesn't do:
- Public transport isn't routed, nor routes between two regions the map holds apart (Oslo to Stockholm needs a region holding both, which owners can add).
- A place of a kind is found only around where the phone last asked from. Far from there, the phone has to leave its refresh circle first.
- A phone that isn't allowed to use location all the time sees nothing in the background. The server's check then works only while the app is open.
- The web registers no geofences.
