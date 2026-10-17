/**
 * Token buckets by key, such as a sender's address: each holds up to `burst` sends and gains
 * `perMinute` a minute. Kept in memory; the fullest buckets are dropped first when there are
 * too many keys, since a full bucket is the same as none.
 */
export class Limits {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  /** Takes one send from `key`'s bucket; false when it is empty. */
  take(key: string): boolean {
    const now = this.now();
    const found = this.buckets.get(key);
    const tokens =
      found === undefined
        ? this.burst
        : Math.min(this.burst, found.tokens + ((now - found.at) * this.perMinute) / 60_000);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return false;
    }
    if (found === undefined && this.buckets.size >= this.maxKeys) this.prune(now);
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    return true;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets)
      if (bucket.tokens + ((now - bucket.at) * this.perMinute) / 60_000 >= this.burst)
        this.buckets.delete(key);
    // Still full: everyone is sending at once, so start over rather than grow without end.
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}
