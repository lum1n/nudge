/** A mistake in how the command was called; printed as its message alone. */
export class UsageError extends Error {
  override name = "UsageError";
}
