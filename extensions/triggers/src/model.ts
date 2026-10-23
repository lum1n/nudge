import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";

// Stored in a document, so plain JSON.
export type Trigger = {
  /** `t1`, `t2`, … across the assistant. */
  id: string;
  roomId: string;
  /** A short name people know it by, such as "Washing machine". */
  name: string;
  /** What the assistant does when it fires, in the room's words. */
  instructions: string;
  /** SHA-256 of the secret in its address, hex; the secret itself is in the extension's secrets. */
  hash: string;
  createdAt: number;
  /** Who asked for it; they alone see its address. */
  createdBy?: { playerId: string; displayName: string };
  /** Added in answer to something private: only this player hears what it starts. */
  privateTo?: { playerId: string; displayName: string };
  /** Calls that started a turn. */
  fired: number;
  lastFiredAt?: number;
  /** Calls refused for coming too often. */
  dropped: number;
  /** When the calls of the last hour started a turn, oldest first. */
  recent: number[];
};

export type TriggersState = { items: Trigger[]; next: number };

/** Every room's triggers: a call has only the secret to go on, so they are looked up together. */
export const TriggersDoc = defineDoc<TriggersState>({
  kind: "triggers.list",
  version: 1,
  scope: "session",
  initial: () => ({ items: [], next: 1 }),
});

/** Where the secret goes in the address. */
export const SECRETS_SCOPE = "triggers";

export const HOUR = 3_600_000;

/** A new secret for a trigger's address: 24 random bytes, URL-safe. */
export function newSecret(): string {
  return randomBytes(24).toString("base64url");
}

export function hashOf(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** The trigger whose secret this is, compared in constant time. */
export function findBySecret(items: readonly Trigger[], secret: string): Trigger | undefined {
  const hash = Buffer.from(hashOf(secret), "hex");
  return items.find((item) => {
    const other = Buffer.from(item.hash, "hex");
    return other.length === hash.length && timingSafeEqual(other, hash);
  });
}

/**
 * Takes one call against the limit of `max` an hour: the calls of the last hour with this one
 * added, or, when there are `max` already, when the next would be let in.
 */
export function admit(
  recent: readonly number[],
  now: number,
  max: number,
): { recent: number[] } | { retryAt: number } {
  const kept = recent.filter((at) => at > now - HOUR);
  if (kept.length >= max) return { retryAt: kept[kept.length - max]! + HOUR };
  return { recent: [...kept, now] };
}
