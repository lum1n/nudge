import { describe, expect, it } from "vitest";
import { apply, diff, type Op } from "../src/index.ts";

/** A small seeded generator, so a failing case can be replayed. */
function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]) => items[int(items.length)]!;
  return { next, int, pick };
}

type Random = ReturnType<typeof random>;

function value(r: Random, depth: number): unknown {
  const kind = depth > 2 ? r.int(4) : r.int(7);
  switch (kind) {
    case 0:
      return r.pick(["", "a", "ab", "hello", "hello world"]);
    case 1:
      return r.int(5);
    case 2:
      return r.pick([true, false, null]);
    case 3:
      return r.pick(["x", "y"]);
    case 4:
      return Array.from({ length: r.int(4) }, () => value(r, depth + 1));
    case 5:
      return Array.from({ length: r.int(5) }, () => item(r, depth + 1));
    default:
      return Object.fromEntries(
        Array.from({ length: r.int(4) }, () => [
          r.pick(["a", "b", "c", "type"]),
          value(r, depth + 1),
        ]),
      );
  }
}

let ids = 0;
function item(r: Random, depth: number): unknown {
  return { id: `i${ids++}`, type: r.pick(["user", "answer"]), text: value(r, depth + 1) };
}

/** `v` changed a little, the way a view changes between frames. */
function mutate(r: Random, v: unknown, depth = 0): unknown {
  if (r.next() < 0.15) return value(r, depth);
  if (typeof v === "string")
    return r.next() < 0.6 ? v + r.pick(["!", " more", "x"]) : `${r.pick(["z", ""])}${v}`;
  if (Array.isArray(v)) {
    const copy = v.map((x) => (r.next() < 0.3 ? mutate(r, x, depth + 1) : x));
    const change = r.int(5);
    if (change === 0 && copy.length > 0) copy.splice(0, 1 + r.int(copy.length));
    if (change === 1) copy.push(item(r, depth + 1));
    if (change === 2 && copy.length > 0) copy.splice(r.int(copy.length), 1);
    if (change === 3) copy.splice(r.int(copy.length + 1), 0, value(r, depth + 1));
    return copy;
  }
  if (typeof v === "object" && v !== null) {
    const copy: Record<string, unknown> = { ...v };
    for (const key of Object.keys(copy))
      if (r.next() < 0.4) copy[key] = r.next() < 0.2 ? undefined : mutate(r, copy[key], depth + 1);
    if (r.next() < 0.3) copy[r.pick(["a", "b", "c", "d"])] = value(r, depth + 1);
    return copy;
  }
  return value(r, depth);
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

describe("diff and apply", () => {
  it("apply(a, diff(a, b)) is b, over random changes, and leaves a alone", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = random(seed);
      const a = { view: value(r, 0) };
      let b: unknown = a;
      for (let step = r.int(3); step >= 0; step--) b = mutate(r, b);
      const before = JSON.stringify(a);
      const ops = json(diff(a, b)) as Op[];
      expect(json(apply(a, ops)), `seed ${seed}`).toEqual(json(b));
      expect(JSON.stringify(a), `seed ${seed}`).toBe(before);
    }
  });

  it("appends to strings that grew at their end", () => {
    const a = { timeline: [{ id: "x", parts: [{ type: "text", text: "Hel" }] }] };
    const b = { timeline: [{ id: "x", parts: [{ type: "text", text: "Hello" }] }] };
    expect(diff(a, b)).toEqual([
      { op: "append", path: ["timeline", 0, "parts", 0, "text"], text: "lo" },
    ]);
  });

  it("drops the oldest items of a sliding window with one splice", () => {
    const a = { timeline: [{ id: "1" }, { id: "2" }, { id: "3" }] };
    const b = { timeline: [{ id: "2" }, { id: "3" }, { id: "4" }] };
    expect(diff(a, b)).toEqual([
      { op: "splice", path: ["timeline"], index: 0, remove: 1, insert: [] },
      { op: "splice", path: ["timeline"], index: 2, remove: 0, insert: [{ id: "4" }] },
    ]);
  });

  it("deletes keys that went away, and sets a new value where the type changed", () => {
    expect(
      diff({ a: 1, b: { type: "text", text: "x" } }, { b: { type: "tool", name: "y" } }),
    ).toEqual([
      { op: "del", path: ["a"] },
      { op: "set", path: ["b"], value: { type: "tool", name: "y" } },
    ]);
  });

  it("skips parts that are the same object", () => {
    const shared = { id: "1", text: "x" };
    expect(diff({ list: [shared] }, { list: [shared] })).toEqual([]);
  });

  it("changes nothing in place and shares what did not change", () => {
    const untouched = { id: "1" };
    const a = { left: untouched, right: { text: "a" } };
    const b = apply(a, [{ op: "append", path: ["right", "text"], text: "b" }]);
    expect(b).toEqual({ left: untouched, right: { text: "ab" } });
    expect(b.left).toBe(untouched);
    expect(a.right.text).toBe("a");
  });

  it("throws on ops that don't fit the view", () => {
    expect(() => apply({ a: 1 }, [{ op: "append", path: ["a"], text: "x" }])).toThrow();
    expect(() => apply({ a: [] }, [{ op: "set", path: ["a", 3], value: 1 }])).toThrow();
    expect(() =>
      apply({ a: [] }, [{ op: "splice", path: ["a"], index: 2, remove: 0, insert: [] }]),
    ).toThrow();
    expect(() => apply({}, [{ op: "set", path: ["a", "b"], value: 1 }])).toThrow();
  });
});
