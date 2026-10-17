/**
 * Which players have which rooms open right now, such as on a socket a host serves. Hosts report
 * into it, and extensions read it, such as to hold back a push to someone already watching.
 * Kept in memory only: after a restart nobody has anything open until they connect again.
 */
export class Presence {
  /** Open rooms by player and room, counted, since one person may have a room open twice. */
  private readonly open = new Map<string, number>();

  /** Counts the room as open for the player until the returned function is called. */
  opened(playerId: string, roomId: string): () => void {
    const key = keyOf(playerId, roomId);
    this.open.set(key, (this.open.get(key) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const left = (this.open.get(key) ?? 1) - 1;
      if (left === 0) this.open.delete(key);
      else this.open.set(key, left);
    };
  }

  isOpen(playerId: string, roomId: string): boolean {
    return this.open.has(keyOf(playerId, roomId));
  }
}

function keyOf(playerId: string, roomId: string): string {
  return `${playerId}\0${roomId}`;
}
