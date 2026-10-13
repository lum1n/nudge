import { applyImmutable, type Decoder, decoder } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { ServerFrame } from "@nudge/server";

export type { ConversationView };

/**
 * A room's conversation view, kept in step with the server's `view` and `ops` frames. Every change
 * makes a new value that shares whatever did not change, so a part of the view that is the same
 * object as before is unchanged. Never mutate a value it hands out.
 */
export class ViewMirror {
  value: ConversationView | undefined;
  private ops: Decoder = decoder();

  /** Takes a frame of the stream; true when it changed the view. */
  receive(frame: ServerFrame): boolean {
    if (frame.type === "view") {
      // A new socket starts over: its ops refer to paths this decoder has not seen.
      this.ops = decoder();
      this.value = frame.value;
      return true;
    }
    if (frame.type !== "ops") return false;
    if (this.value === undefined) throw new Error("Ops arrived before the view");
    this.value = applyImmutable(this.value, this.ops.decode(frame.ops));
    return true;
  }
}
