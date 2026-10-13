import type { Context } from "@earendil-works/chord";
import { Nudge, type NudgeOptions } from "./nudge.ts";

export { Nudge, type NudgeOptions };

export function createNudge(options: NudgeOptions, context: Context): Promise<Nudge> {
  return Nudge.open(options, context);
}
