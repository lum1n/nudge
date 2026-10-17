/**
 * What changed: the room list, one room's memory, nudges or approvals, who may see which values (a
 * value made private or forgotten), which changes what every view shows, a player's profile, or
 * a player's own memory.
 */
export type Change =
  | { readonly kind: "rooms" | "vault" }
  | { readonly kind: "memory" | "nudges" | "approvals"; readonly roomId: string }
  | { readonly kind: "profile" | "player-memory"; readonly playerId: string };

export type ChangeListener = (change: Change) => void;

/**
 * Tells hosts that something outside a conversation's entries changed, so they can read it again.
 * Fired after the commit by the host-facing methods (`Memory`, `Nudges`, `Approvals`, `Rooms`, `Profiles`).
 * What tools change inside a turn is not reported here, since it lands with the turn's entries;
 * a player's own memory is the exception, as it reaches past the room.
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
