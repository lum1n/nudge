# Write an extension

`extensions/hello/src/index.ts` is a whole one:

```ts
import { defineNudgeExtension, defineTool, regexDetector, section, Type } from "@nudge/core";

export default defineNudgeExtension({
  name: "hello",
  version: "0.1.0",
  settings: Type.Object({
    greeting: Type.String({ default: "Hello", minLength: 1 }),
    maxSides: Type.Integer({ default: 100, minimum: 2 }),
  }),
  setup: ({ settings, displayName }) => ({
    sections: [
      section(
        "greeting",
        () => `When someone greets ${displayName}, answer with "${settings.greeting}" first.`,
      ),
    ],
    tools: [
      defineTool({
        name: "roll_dice",
        description: "Roll dice; use it whenever someone asks for a random number or a dice roll.",
        parameters: Type.Object({ sides: Type.Optional(Type.Integer({ minimum: 2 })) }),
        execute: async ({ sides = 6 }) => ({
          output: [{ type: "text", text: String(1 + Math.floor(Math.random() * sides)) }],
        }),
      }),
    ],
    // Norwegian licence plates never reach the model.
    detectors: [regexDetector("PLATE", /(?<![\p{L}\p{N}])[A-Z]{2} ?\d{5}(?![\p{L}\p{N}])/u)],
  }),
});
```

- `setup` runs when the assistant opens and on every reload. It gets the settings (checked against the schema, defaults filled in), the assistant's `displayName`, `timeZone` and clock, `protect(value, kind)` to keep a value from the model and `release(value)` to make one readable again.
- `playerSettings` is a schema of what each player chooses for themselves, such as hello's default number of sides. Players set it on their profile, and `playerSettings(playerId, context)` in `setup`'s host reads it with defaults filled in; a tool finds who asked in `currentTurn().by`. Every required one needs a default, for players who chose nothing.
- `setup` can also return `routes`, HTTP routes under `/v1/a/<assistant>/ext/<name>/`. Each takes a standard `Request` and returns a `Response`, and says whether it needs a player's token (`auth: "player"`), an admin's (`"admin"`) or none (`"none"`); the server checks the token and the body's size (`maxBodyBytes`, default 64 KiB) first.
- It returns a [Pi Durable extension](https://www.npmjs.com/package/@earendil-works/pi-durable) without its name (`tools`, `sections`, `hooks`, `wraps`, `tasks`) plus `detectors`, which run after the built-in ones.
- Take what it needs from Pi, such as `defineDoc`, `Tx` or `BACKGROUND_CONTEXT`, from `@nudge/core`, and the faux model provider for tests from `@nudge/core/testing`; don't depend on a Pi package directly ([ADR 1](../adr/0001-pi-durable.md)).
- Export it as `default` (or as `extension`). Plain Pi Durable extensions load too, without settings.
- Tool arguments arrive with personal values restored and tool output is redacted again before the model sees it, so tools work with real data.
- A tool that returns what others wrote, such as mail, pages or an API's answer, is marked with `returnsUntrusted(tool)`: the model gets its output wrapped as `<untrusted-data source="…">`, and the system prompt tells it not to take instructions from it. A tool that could send something out checks `currentTurn().untrusted` and asks for approval when the turn has read such data; `untrustedData(source, text)` wraps text that reaches the model another way ([ADR 20](../adr/0020-untrusted-content-and-outbound-calls.md)).
- In code, pass extensions to `createNudge({ extensions: [hello, { extension: hello, settings }] })` and swap them with `nudge.reloadExtensions([...])`.

See ADR 0003 for why extensions look like this.
