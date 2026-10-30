# 29. Cards show maps, charts, stats, progress and timelines, and ask for days and times

Cards (ADR 27) had text, tables and buttons. Much of what Nudge answers is better seen than read: where three flats are, what was spent each month, how far a savings goal has come, where a delivery is. A table of coordinates or numbers makes people do the drawing in their head.

**Five new block types, still data:**

- `map`: `markers` (`lat`, `lon`, `label`; up to 20) and an optional `path` (2 to 200 points), such as a route or a track. It needs one or the other.
- `chart`: `kind` is `bar`, `line`, `area` or `pie`. `labels` names each point along the x axis (each slice of a pie), and each of up to 6 `series` has a value per label, with `null` for a gap. An optional `unit`. A pie takes one series and up to 8 slices, none negative.
- `stats`: up to 6 headline numbers, each a `label` and a `value` (as text, already formatted), with an optional `change` such as `+12%` and a `tone` (`good`, `bad` or `neutral`) for its colour. Which way is good depends on the number (spending going up is bad), so the tool says it.
- `progress`: up to 10 bars, each a `label`, a `value`, a `max` (100 when absent) and an optional `note` shown in place of the percentage.
- `timeline`: up to 20 steps in order, each a `title`, with an optional `time` as people read it, a `subtitle` and a `state` (`done`, `current` or `upcoming`).

Fields gain `date` (sent as `YYYY-MM-DD`) and `time` (`HH:MM`), which each app asks for with its own picker. The server checks the format and that the day exists. An app that doesn't know the type yet shows a text field, and the server still checks what is typed.

What the schema can't say, `cardProblem` does: a map with nothing on it, a series with more or fewer values than labels, a pie with more than one series. `show_ui` refuses those cards with the reason. A card from another tool that fails these checks is still shown, as the projection only checks the schema, so each app draws what it can of a chart whose series are uneven (a missing value is a gap).

**A map loads tiles, but from the app's own source.** ADR 27 says a card names no address an app would load, so a card can't make an app fetch a tracking pixel. A map gives only coordinates. The app draws the map from its own map source: Apple Maps on Apple, and OpenStreetMap's tiles on the web and Android. So the tile server learns which area was looked at, as it does for any map the person opens, and the tool can't choose who learns it. The web app and Android draw the tiles themselves around the points, at the closest zoom that holds them all, with no map library; a tap or link opens the place in a map app. The map isn't panned in the chat, so scrolling the chat never gets caught by it.

**Charts are drawn by each app**, as SVG on the web, on a Compose `Canvas` on Android, and with Swift Charts on Apple, with no library added. All three use the same eight colours in the same order: each pair next to each other stays apart for colour-blind readers, and a dark surface gets the same hues stepped for it. That order is why a chart takes 6 series and a pie 8 slices: past that, colours would repeat. A chart with more than one series has a legend, a pie lists each slice with its value and share, and a mark's value is in its tooltip or its accessibility label, so no value is told by colour alone. Two measures of different scale go in two charts: there is no second y axis.

The Swift and Kotlin libraries parse the new blocks; an older app skips them as blocks it doesn't know, and the card's other blocks still show.
