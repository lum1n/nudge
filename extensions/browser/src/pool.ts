import { BrowserSession, type BrowserOptions } from "./browser.ts";

type Slot = {
  session?: Promise<BrowserSession>;
  /** Live viewers keep the browser open. */
  holders: number;
  /** Tasks on one profile run one at a time; they share the browser's tabs. */
  queue: Promise<unknown>;
  idle?: NodeJS.Timeout;
};

// Module state outlives `nudge reload`, which re-imports only the extension's entry module.
const slots = new Map<string, Slot>();

/** Runs `use` with the browser for `options.profileDir`, opening it if needed and closing it after `idleMs` unused. */
export function withBrowser<T>(
  options: BrowserOptions,
  idleMs: number,
  use: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  const key = options.profileDir;
  const slot = slotFor(key);
  const run = async (): Promise<T> => {
    clearTimeout(slot.idle);
    try {
      return await use(await open(slot, options));
    } finally {
      idleLater(slot, key, idleMs);
    }
  };
  const result = slot.queue.then(run, run);
  slot.queue = result.catch(() => {});
  return result;
}

/**
 * The browser for `options.profileDir` for a live viewer: no waiting behind running tasks, which
 * it watches and can take over. It stays open until `release`, then closes after `idleMs` unused.
 */
export async function holdBrowser(
  options: BrowserOptions,
  idleMs: number,
): Promise<{ session: BrowserSession; release: () => void }> {
  const key = options.profileDir;
  const slot = slotFor(key);
  slot.holders++;
  clearTimeout(slot.idle);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slot.holders--;
    idleLater(slot, key, idleMs);
  };
  try {
    return { session: await open(slot, options), release };
  } catch (error) {
    release();
    throw error;
  }
}

function slotFor(key: string): Slot {
  const slot = slots.get(key) ?? { queue: Promise.resolve(), holders: 0 };
  slots.set(key, slot);
  return slot;
}

function open(slot: Slot, options: BrowserOptions): Promise<BrowserSession> {
  slot.session ??= BrowserSession.open(options).then((session) => {
    session.context.on("close", () => {
      if (slots.get(options.profileDir) === slot) slot.session = undefined;
    });
    return session;
  });
  return slot.session.catch((error: unknown) => {
    slot.session = undefined;
    throw error;
  });
}

function idleLater(slot: Slot, key: string, idleMs: number): void {
  clearTimeout(slot.idle);
  if (slot.holders > 0) return;
  slot.idle = setTimeout(() => void closeBrowser(key), idleMs);
  slot.idle.unref();
}

export async function closeBrowser(profileDir: string): Promise<void> {
  const slot = slots.get(profileDir);
  if (!slot?.session) return;
  const pending = slot.session;
  slot.session = undefined;
  clearTimeout(slot.idle);
  await (await pending.catch(() => undefined))?.close();
}

export async function closeAllBrowsers(): Promise<void> {
  await Promise.all([...slots.keys()].map(closeBrowser));
}
