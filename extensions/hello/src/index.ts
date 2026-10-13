import { defineNudgeExtension, defineTool, regexDetector, section, Type } from "@nudge/core";

/**
 * The smallest useful extension: a prompt section that uses a setting, a tool, and a detector that
 * keeps Norwegian licence plates from the model.
 */
export default defineNudgeExtension({
  name: "hello",
  version: "0.1.0",
  description: "Greets in your words, rolls dice, and keeps licence plates private",
  settings: Type.Object({
    greeting: Type.String({ default: "Hello", minLength: 1 }),
    /** Most sides `roll_dice` accepts. */
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
        parameters: Type.Object({
          sides: Type.Optional(Type.Integer({ minimum: 2, description: "Default 6." })),
          count: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 20, description: "Default 1." }),
          ),
        }),
        execute: async ({ sides = 6, count = 1 }) => {
          if (sides > settings.maxSides)
            return {
              output: [{ type: "text", text: `At most ${settings.maxSides} sides.` }],
              isError: true,
            };
          const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
          return { output: [{ type: "text", text: rolls.join(", ") }] };
        },
      }),
    ],
    detectors: [regexDetector("PLATE", /(?<![\p{L}\p{N}])[A-Z]{2} ?\d{5}(?![\p{L}\p{N}])/u)],
  }),
});
