import { describe, expect, it } from "vitest";
import { slugOf } from "../src/slug.ts";

describe("slugOf", () => {
  it("names an assistant's address from its display name", () => {
    expect(slugOf("Robin Hood")).toBe("robin-hood");
    expect(slugOf("  Åse's  Ålesund-bot! ")).toBe("ase-s-alesund-bot");
    expect(slugOf("Zoë")).toBe("zoe");
    expect(slugOf("!!!")).toBe("");
    expect(slugOf("x".repeat(60))).toHaveLength(40);
  });

  it("spells out the letters NFKD leaves whole, as the CLI does", () => {
    expect(slugOf("Bjørn")).toBe("bjorn");
    expect(slugOf("Æsa")).toBe("aesa");
    expect(slugOf("ØRJAN BLÅBÆR")).toBe("orjan-blabaer");
    expect(slugOf("Straße STRAẞE")).toBe("strasse-strasse");
    expect(slugOf("Đorđe Łukasz Þóra")).toBe("dorde-lukasz-thora");
  });
});
