# 14. Personal details and location are private values, shown to the model in the person's own turns

The assistant does more for someone who knows their name, e-mail, phone and address, and where they are now: it can fill in a form, write a mail from them, look for what is near. None of it may reach a model provider.

**The values are vault entries the person owns (ADR 9).** `PATCH /me/personal` protects each one with the player as owner, kind `NAME`, `EMAIL`, `PHONE`, `ADDRESS` or `LOCATION`, and the `nudge.personal` document keeps only the placeholders. So the redaction every request goes through already covers them wherever they are written, others see placeholders in shared rooms, the player sees and can forget them under hidden values, and a forgotten one drops out of their details.

**The model gets the placeholders in the person's own turns only.** The built-in `personal` section lists them in the player's personal room and in turns private to them, never in shared turns: tools put every value back, so a model that knew Ann's placeholders in a room with Bo could be asked by Bo to send her address somewhere. Side conversations, which talk to people outside, get none.

**Kept at home, apart from the profile.** A home sends the profile to every assistant its player joined (ADR 10). Details are not in it, and a guest's `PATCH /me/personal` is a 403: the apps send them, and the location, to home only.

**One location, coarse and short-lived.** The apps send where the device is while they are open (about 100 m accuracy, every 200 m), with a place name from the phone's own geocoder; the web sends coordinates when asked. It is kept as `"<place> (<lat>, <lon>)"` to four decimals. A spot within 100 m of the last keeps its placeholder, so the prompt and its cache don't change as someone moves around a room; one further away gets a new placeholder and the old one is forgotten, so the vault holds no history of where someone was. The section gives its time to the hour, for the same reason.

**Shared rooms only with consent, and in sight.** A player can let the model know where they are in a shared room they are in (`PUT /rooms/<id>/location`), off by default and per room. Then the section lists their location there, but none of their other details, in every turn, since anyone there may now ask about what is near them; that is what they agreed to. The room view's `sharingLocation` names who shares, so the room shows it to everyone in it, and the apps show it in a personal room too once a location is known. The others still see a placeholder for the place: their consent is to the assistant using it, not to a readable trail in the transcript. Membership is fixed when a room is made, so consent can't carry over to people added later.

**Coordinates as values of their own.** Besides the text, latitude and longitude go into the vault as the player's `LATITUDE` and `LONGITUDE`, to the same four decimals, and the section names them. A tool that takes coordinates, such as a weather or transit service through a connector, then gets numbers rather than `"Oslo S (59.9139, 10.7522)"`. They are kept and forgotten with the location.

What this doesn't do: the apps don't share in the background, and the details don't follow a person to the assistants they joined.
