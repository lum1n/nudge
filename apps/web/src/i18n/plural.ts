/** `one` for exactly one, else `other`: enough for English and bokmål. */
export function plural(count: number, one: string, other: string): string {
  return count === 1 ? one : other;
}
