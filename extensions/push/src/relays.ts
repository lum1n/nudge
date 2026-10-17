/**
 * Sends pushes through push relays (ADR 10), for apps whose APNs key or Firebase project this
 * server doesn't have. Only to the relays the admin listed: the server POSTs to them.
 */
export class Relays {
  private readonly allowed: ReadonlySet<string>;

  constructor(
    urls: readonly string[],
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.allowed = new Set(urls.map(normalize));
  }

  get urls(): string[] {
    return [...this.allowed];
  }

  /** The relay as this server lists it, or undefined when it doesn't send through it. */
  find(url: string): string | undefined {
    const normal = normalize(url);
    return this.allowed.has(normal) ? normal : undefined;
  }

  /**
   * Sends one push sealed for the device. `gone` means the relay can't reach the device with that
   * handle any more, so it should be forgotten; other failures throw.
   */
  async send(
    relay: string,
    push: { handle: string; sealed: string; collapseId: string },
  ): Promise<"sent" | "gone"> {
    const response = await this.fetch(`${relay}/v1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(push),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return "sent";
    if (response.status === 410) return "gone";
    throw new Error(
      `Relay ${relay} answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
