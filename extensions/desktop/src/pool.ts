import { DesktopSession, type DesktopOptions } from "./session.ts";

type Slot = {
  session?: Promise<DesktopSession>;
  /** Live viewers keep the desktop open. */
  holders: number;
  /** Tasks on one desktop run one at a time; they share its windows. */
  queue: Promise<unknown>;
  idle?: NodeJS.Timeout;
};

// Module state outlives `nudge reload`, which re-imports only the extension's entry module.
const slots = new Map<string, Slot>();
/** The desktops open now, for killing them in a hurry. */
const opened = new Set<DesktopSession>();

/** Runs `use` with the desktop for `options.homeDir`, opening it if needed and closing it after `idleMs` unused. */
export function withDesktop<T>(
  options: DesktopOptions,
  idleMs: number,
  use: (session: DesktopSession) => Promise<T>,
): Promise<T> {
  const key = options.homeDir;
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
 * The desktop for `options.homeDir` for a live viewer: no waiting behind running tasks, which it
 * watches and can take over. It stays open until `release`, then closes after `idleMs` unused.
 */
export async function holdDesktop(
  options: DesktopOptions,
  idleMs: number,
): Promise<{ session: DesktopSession; release: () => void }> {
  const key = options.homeDir;
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

async function open(slot: Slot, options: DesktopOptions): Promise<DesktopSession> {
  stopOnExit();
  slot.session ??= DesktopSession.open(options).then((session) => {
    opened.add(session);
    return session;
  });
  try {
    const session = await slot.session;
    // The apps and sandbox follow the settings, also for a desktop opened before they changed.
    session.options = { ...session.options, apps: options.apps, sandbox: options.sandbox };
    return session;
  } catch (error) {
    slot.session = undefined;
    throw error;
  }
}

function idleLater(slot: Slot, key: string, idleMs: number): void {
  clearTimeout(slot.idle);
  if (slot.holders > 0) return;
  slot.idle = setTimeout(() => void closeDesktop(key), idleMs);
  slot.idle.unref();
}

/** Closes the desktop for `homeDir` once the task running on it, if any, is done. */
export function closeDesktop(homeDir: string): Promise<void> {
  const slot = slots.get(homeDir);
  if (!slot) return Promise.resolve();
  const close = async () => {
    clearTimeout(slot.idle);
    const pending = slot.session;
    slot.session = undefined;
    const session = await pending?.catch(() => undefined);
    if (!session) return;
    opened.delete(session);
    await session.close();
  };
  const done = slot.queue.then(close, close);
  slot.queue = done.catch(() => {});
  return done;
}

/** Closes every desktop whose home is under `root`, or every one, after their running tasks. */
export async function closeAllDesktops(root?: string): Promise<void> {
  const keys = [...slots.keys()].filter((key) => root === undefined || key.startsWith(root));
  await Promise.all(keys.map(closeDesktop));
}

let stopping = false;

/**
 * Kills every desktop's processes when Nudge stops: they run detached, so they would outlive it.
 * On exit, and on SIGTERM and SIGINT when nothing else handles them yet (`nudge serve` does, and
 * exits, which runs the exit hook); then the signal is raised again, so the process still ends.
 * What a SIGKILL leaves behind, the next desktop's start sweeps up (`sweepDesktops`).
 */
function stopOnExit(): void {
  if (stopping) return;
  stopping = true;
  const killAll = () => {
    for (const session of opened) session.kill();
    opened.clear();
  };
  process.once("exit", killAll);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    if (process.listenerCount(signal) > 0) continue;
    const onSignal = () => {
      killAll();
      if (process.listenerCount(signal) > 1) return;
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}
