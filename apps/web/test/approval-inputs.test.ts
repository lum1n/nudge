import type { ApprovalInput } from "@nudge/client";
import { describe, expect, it, vi } from "vitest";
import { decideWithInputs, inputsFilled, inputsToSend } from "../src/approval-inputs.ts";

const inputs: ApprovalInput[] = [
  { name: "token", label: "Token", secret: true },
  { name: "note", label: "Note", secret: false, optional: true },
];

describe("an approval's inputs", () => {
  it("holds Approve until every required one is filled", () => {
    expect(inputsFilled(inputs, {})).toBe(false);
    expect(inputsFilled(inputs, { token: "", note: "hi" })).toBe(false);
    expect(inputsFilled(inputs, { token: "s3cret" })).toBe(true);
    expect(inputsFilled([], {})).toBe(true);
  });

  it("sends only the approval's own, non-empty values", () => {
    expect(inputsToSend(inputs, { token: "s3cret", note: "", other: "x" })).toEqual({
      token: "s3cret",
    });
    expect(inputsToSend([], { token: "s3cret" })).toBeUndefined();
  });

  it("sends the values when approving, none when denying, and clears them either way", async () => {
    const decide = vi.fn(async () => {});
    const clear = vi.fn();
    await decideWithInputs(decide, true, inputs, { token: "s3cret" }, clear);
    expect(decide).toHaveBeenLastCalledWith(true, { token: "s3cret" });
    expect(clear).toHaveBeenCalledTimes(1);
    await decideWithInputs(decide, false, inputs, { token: "s3cret" }, clear);
    expect(decide).toHaveBeenLastCalledWith(false, undefined);
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("clears the values when the server refuses them too", async () => {
    const clear = vi.fn();
    const refused = decideWithInputs(
      async () => {
        throw new Error("token: required");
      },
      true,
      inputs,
      { token: "x" },
      clear,
    );
    await expect(refused).rejects.toThrow("token: required");
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
