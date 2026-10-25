import { afterEach, describe, expect, it } from "vitest";
import { en } from "../src/i18n/en.ts";
import { dateLocale, m, pickLocale, setLocale } from "../src/i18n/index.ts";
import { nb } from "../src/i18n/nb.ts";

/** Every message's path, `room.send`, with what it is: a string or a function. */
function shape(messages: object, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix + key;
    if (typeof value === "object" && value !== null) Object.assign(out, shape(value, `${path}.`));
    else out[path] = typeof value;
  }
  return out;
}

afterEach(() => setLocale("en"));

describe("pickLocale", () => {
  it("speaks bokmål to every kind of Norwegian", () => {
    expect(pickLocale(["nb-NO"])).toBe("nb");
    expect(pickLocale(["nn"])).toBe("nb");
    expect(pickLocale(["no"])).toBe("nb");
    expect(pickLocale(["NB_no"])).toBe("nb");
  });

  it("takes the first language it knows, and English otherwise", () => {
    expect(pickLocale(["en-GB", "nb"])).toBe("en");
    expect(pickLocale(["de-DE", "nb-NO", "en"])).toBe("nb");
    expect(pickLocale(["de-DE", "sv"])).toBe("en");
    expect(pickLocale([])).toBe("en");
  });
});

describe("messages", () => {
  it("has every English message in bokmål, of the same kind", () => {
    expect(shape(nb)).toEqual(shape(en));
  });

  it("leaves no bokmål message empty", () => {
    const empty = Object.entries(shape(nb)).filter(
      ([path, kind]) =>
        kind === "string" &&
        path.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], nb) ===
          "",
    );
    expect(empty).toEqual([]);
  });

  it("switches language", () => {
    setLocale("nb");
    expect(m.common.today).toBe("I dag");
    setLocale("en");
    expect(m.common.today).toBe("Today");
  });
});

describe("dateLocale", () => {
  it("writes dates in the app's language", () => {
    setLocale("nb");
    expect(dateLocale()).toBe("nb-NO");
    expect(new Date(2026, 9, 25).toLocaleDateString(dateLocale(), { month: "long" })).toBe(
      "oktober",
    );
  });
});
