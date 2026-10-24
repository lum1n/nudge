import { defineNudgeExtension, nameDetector, Type } from "@nudge/core";

const VERSION = "0.1.0";

const Settings = Type.Object({
  extraNames: Type.Array(Type.String(), {
    default: [],
    description: "More given names, family names or whole names to find, such as relatives'.",
  }),
});

/**
 * Names and street addresses are found by every assistant now (ADR 22); this adds the names the
 * lists don't have.
 */
export const nerExtension = defineNudgeExtension({
  name: "ner",
  version: VERSION,
  apiVersion: "1.0",
  description: "Find more people's names, such as relatives', than the built-in name lists know.",
  settings: Settings,
  setup: ({ settings }) => ({
    detectors: settings.extraNames.length === 0 ? [] : [nameDetector(settings.extraNames)],
  }),
});

export default nerExtension;
