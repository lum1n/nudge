# Watches

`extensions/watches` lets a room ask the assistant to keep an eye on something: "tell me when a 2027 GLC under 800 000 kr shows up on Finn", "when tomorrow's power price goes above 2 kr". The model adds a watch with `add_watch` (what to check, and how often), and `list_watches` and `remove_watch` show and stop them.

- Each check runs in a side conversation of the room, out of the room's sight but with its tools, connectors, logins and memory. The model replies with the items that match, each with a stable key such as its URL.
- The room hears only about items it hasn't seen before. That arrives like a fired nudge, so push and chat bridges deliver it too.
- Every check is a model run with tools, so it costs: `minMinutes` (default 30) caps how often, and `maxPerRoom` (default 10) how many.
- With the scripts extension on, a watch can name a saved script (`add_watch` with `script`). Each check then runs that script instead of the model and costs nothing, so it may run as often as `minScriptMinutes` (default 5). The model is asked to tell the room only when the script finds something new. If the script also returns a `message`, that text is posted as it is, and no model runs at all.
