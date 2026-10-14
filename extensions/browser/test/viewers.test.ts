import { describe, expect, it } from "vitest";
import type { LiveOutput } from "../src/live.ts";
import { Viewers } from "../src/viewers.ts";

const viewer = (name: string) => {
  const got: LiveOutput[] = [];
  return { name, send: (o: LiveOutput) => got.push(o), got, last: () => got.at(-1) };
};

describe("Viewers", () => {
  it("gives the first viewer control, lets another take it, and passes it on when the holder leaves", () => {
    const viewers = new Viewers();
    const ann = viewer("Ann");
    const bo = viewer("Bo");
    viewers.join(ann);
    expect(ann.last()).toEqual({ type: "control", holder: "Ann", you: true });
    viewers.join(bo);
    expect(bo.last()).toEqual({ type: "control", holder: "Ann", you: false });
    viewers.take(bo);
    expect(viewers.holder).toBe(bo);
    expect(ann.last()).toEqual({ type: "control", holder: "Bo", you: false });
    viewers.leave(bo);
    expect(ann.last()).toEqual({ type: "control", holder: "Ann", you: true });
    viewers.leave(ann);
    expect(viewers.holder).toBeUndefined();
  });

  it("broadcasts to everyone watching", () => {
    const viewers = new Viewers();
    const ann = viewer("Ann");
    const bo = viewer("Bo");
    viewers.join(ann);
    viewers.join(bo);
    viewers.broadcast({ type: "logins", logins: [] });
    expect(ann.last()).toEqual({ type: "logins", logins: [] });
    expect(bo.last()).toEqual({ type: "logins", logins: [] });
  });
});
