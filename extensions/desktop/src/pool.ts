import { DesktopSession, type DesktopOptions } from "./session.ts";

type Slot = {
  session?: Promise<DesktopSession>;
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
  const slot = slots.get(key) ?? { queue: Promise.resolve() };
  slots.set(key, slot);
  const run = async (): Promise<T> => {
    clearTimeout(slot.idle);
    try {
      const session = await open(slot, options);
      // The apps follow the settings, also for a desktop opened before they changed.
      session.options = { ...session.options, apps: options.apps };
      return await use(session);
    } finally {
      clearTimeout(slot.idle);
      slot.idle = setTimeout(() => void closeDesktop(key), idleMs);
      slot.idle.unref();
    }
  };
  const result = slot.queue.then(run, run);
  slot.queue = result.catch(() => {});
  return result;
}

function open(slot: Slot, options: DesktopOptions): Promise<DesktopSession> {
  stopOnExit();
  slot.session ??= DesktopSession.open(options).then((session) => {
    opened.add(session);
    return session;
  });
  return slot.session.catch((error: unknown) => {
    slot.session = undefined;
    throw error;
  });
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
