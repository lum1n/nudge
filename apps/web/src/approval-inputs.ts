import type { ApprovalInput } from "@nudge/client";

/** What the reader typed into an approval's fields, by input name. Held only while the card is. */
export type InputValues = Readonly<Record<string, string>>;

/** Whether every input that isn't optional has something in it. */
export function inputsFilled(inputs: readonly ApprovalInput[], values: InputValues): boolean {
  return inputs.every((input) => input.optional === true || (values[input.name] ?? "") !== "");
}

/** The values to approve with: the approval's own inputs, leaving out the empty ones. */
export function inputsToSend(
  inputs: readonly ApprovalInput[],
  values: InputValues,
): Record<string, string> | undefined {
  if (inputs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const input of inputs) {
    const value = values[input.name] ?? "";
    if (value !== "") out[input.name] = value;
  }
  return out;
}

/**
 * Decides an approval, with the inputs when approving, then forgets what was typed whether or not
 * it went through: a refused password is typed again, not kept.
 */
export async function decideWithInputs(
  decide: (approve: boolean, inputs?: Record<string, string>) => Promise<unknown>,
  approve: boolean,
  inputs: readonly ApprovalInput[],
  values: InputValues,
  clear: () => void,
): Promise<void> {
  try {
    await decide(approve, approve ? inputsToSend(inputs, values) : undefined);
  } finally {
    clear();
  }
}
