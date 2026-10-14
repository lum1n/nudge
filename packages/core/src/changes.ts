/** What changed: the room list, or one room's memory, nudges or approvals. */
export type Change =
  | { readonly kind: "rooms" }
  | { readonly kind: "memory" | "nudges" | "approvals"; readonly roomId: string };

export type ChangeListener = (change: Change) => void;

/**
 * Tells hosts that something outside a conversation's entries changed, so they can read it again.
 * Fired after the commit by the host-facing methods (`Memory`, `Nudges`, `Approvals`, `Rooms`).
 * What tools change inside a turn is not reported here; it lands with the turn's entries.
 */
export class Changes {
  private readonly listeners = new Set<ChangeListener>();

  /** Returns a function that stops listening. */
  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change: Change): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A listener's failure is its own; the change has already been committed.
      }
    }
  }
}
