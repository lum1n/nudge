import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepPolling } from "../src/index.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("keepPolling", () => {
  it("reports a failing step and tries again, waiting longer after each failure in a row", async () => {
    const stop = new AbortController();
    const reported: unknown[] = [];
    const steps: number[] = [];
    // Fails three times, succeeds once, fails again, then stops the loop.
    const outcomes = ["fail", "fail", "fail", "ok", "fail", "stop"];
    const loop = keepPolling(
      async () => {
        steps.push(Date.now());
        const outcome = outcomes.shift();
        if (outcome === "stop") stop.abort();
        else if (outcome === "fail") throw new Error(`down ${steps.length}`);
      },
      {
        signal: stop.signal,
        report: (error) => reported.push(error),
        retryMs: 100,
        maxRetryMs: 300,
      },
    );
    await vi.runAllTimersAsync();
    await loop;
    const start = steps[0]!;
    // 100, 200, then 300 at most; back to 100 after the success.
    expect(steps.map((at) => at - start)).toEqual([0, 100, 300, 600, 600, 700]);
    expect(reported.map(String)).toEqual([
      "Error: down 1",
      "Error: down 2",
      "Error: down 3",
      "Error: down 5",
    ]);
  });

  it("waits at least what the error asks for, survives a report that throws, and stops on abort", async () => {
    const stop = new AbortController();
    const steps: number[] = [];
    const loop = keepPolling(
      async () => {
        steps.push(Date.now());
        throw new Error("refused");
      },
      {
        signal: stop.signal,
        report: () => {
          throw new Error("logging broke too");
        },
        retryMs: 100,
        atLeast: () => 1_000,
      },
    );
    await vi.advanceTimersByTimeAsync(2_500);
    stop.abort();
    await loop;
    expect(steps.map((at) => at - steps[0]!)).toEqual([0, 1_000, 2_000]);
  });
});
