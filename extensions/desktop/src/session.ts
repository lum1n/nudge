// A desktop of its own: a virtual display, a session bus and an accessibility bus, with the apps
// the settings allow, read and driven through AT-SPI. Nothing reaches the person's real session.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type Address, Atspi, type Info } from "./atspi.ts";
import { type DesktopNode, type DesktopWindow, renderDesktop } from "./snapshot.ts";

export interface DesktopOptions {
  /** The apps the agent may start, by name: the program and its arguments. */
  apps: Readonly<Record<string, readonly string[]>>;
  /** The desktop's home: the apps' settings and files stay here between sessions. */
  homeDir: string;
  size?: { width: number; height: number };
}

/** An action that could not be done, said so the agent can try something else. */
export class ActionError extends Error {}

const WINDOWS = new Set(["frame", "window", "dialog", "alert", "file chooser"]);
/** Most children read per node, and most nodes per observation. */
const CHILD_LIMIT = 300;
const NODE_LIMIT = 5_000;
/** Actions tried first when clicking, in order; else the first one the object has. */
const CLICKS = ["click", "press", "activate", "toggle", "jump", "open"];

/** Why a desktop can't start here, if it can't: it needs Xvfb, D-Bus and AT-SPI. */
export function desktopProblem(): string | undefined {
  const missing = ["Xvfb", "dbus-daemon"].filter((program) => !onPath(program));
  if (missing.length)
    return `This server has no ${missing.join(" or ")} for the desktop. Install xvfb, dbus and at-spi2-core.`;
  return undefined;
}

export class DesktopSession {
  private readonly refs = new Map<string, string>();
  private readonly addresses = new Map<string, Address>();
  private readonly launched = new Map<number, { name: string; child: ChildProcess }>();
  /** The open modal dialogs, as of the last read. */
  private modals = new Set<string>();
  readonly options: DesktopOptions;
  readonly display: string;
  readonly atspi: Atspi;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runtimeDir: string;
  private readonly processes: ChildProcess[];

  private constructor(
    options: DesktopOptions,
    display: string,
    env: NodeJS.ProcessEnv,
    atspi: Atspi,
    runtimeDir: string,
    processes: ChildProcess[],
  ) {
    this.options = options;
    this.display = display;
    this.env = env;
    this.atspi = atspi;
    this.runtimeDir = runtimeDir;
    this.processes = processes;
  }

  static async open(options: DesktopOptions): Promise<DesktopSession> {
    const problem = desktopProblem();
    if (problem) throw new Error(problem);
    const processes: ChildProcess[] = [];
    const runtimeDir = mkdtempSync(join(tmpdir(), "nudge-desktop-"));
    try {
      const xvfb = await startXvfb(options.size ?? { width: 1280, height: 800 });
      processes.push(xvfb.process);
      mkdirSync(options.homeDir, { recursive: true });
      const base: NodeJS.ProcessEnv = {
        ...process.env,
        DISPLAY: xvfb.display,
        HOME: options.homeDir,
        XDG_RUNTIME_DIR: runtimeDir,
        XDG_CONFIG_HOME: join(options.homeDir, ".config"),
        XDG_DATA_HOME: join(options.homeDir, ".local", "share"),
        XDG_CACHE_HOME: join(options.homeDir, ".cache"),
      };
      // The person's own session must not leak in: apps go to this display and these buses only.
      delete base.WAYLAND_DISPLAY;
      delete base.DBUS_SESSION_BUS_ADDRESS;
      delete base.NO_AT_BRIDGE;
      delete base.AT_SPI_BUS_ADDRESS;
      const bus = await startSessionBus(base, runtimeDir);
      processes.push(bus.process);
      const env: NodeJS.ProcessEnv = {
        ...base,
        DBUS_SESSION_BUS_ADDRESS: bus.address,
        GDK_BACKEND: "x11",
        QT_QPA_PLATFORM: "xcb",
        // Qt, Chromium and Electron only expose their tree when asked to.
        QT_ACCESSIBILITY: "1",
        QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
        ACCESSIBILITY_ENABLED: "1",
        GTK_A11Y: "atspi",
      };
      const atspi = await Atspi.connect(bus.address);
      return new DesktopSession(options, xvfb.display, env, atspi, runtimeDir, processes);
    } catch (error) {
      for (const child of processes) kill(child);
      rmSync(runtimeDir, { recursive: true, force: true });
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const { child } of this.launched.values()) kill(child);
    this.launched.clear();
    this.atspi.close();
    for (const child of this.processes.reverse()) kill(child);
    rmSync(this.runtimeDir, { recursive: true, force: true });
  }

  /** Starts an app from the settings and waits for its first window. */
  async launch(name: string): Promise<string> {
    const command = this.options.apps[name];
    if (!command?.length) {
      const names = Object.keys(this.options.apps);
      throw new ActionError(
        `There is no app called "${name}". ${names.length ? `The apps are: ${names.join(", ")}.` : "No apps are set up."}`,
      );
    }
    const [program, ...args] = command;
    const child = spawn(program!, args, {
      env: this.env,
      cwd: this.options.homeDir,
      stdio: "ignore",
      detached: true,
    });
    const failed = new Promise<never>((_, reject) => {
      child.once("error", (error) =>
        reject(new ActionError(`Could not start ${name}: ${error.message}`)),
      );
    });
    failed.catch(() => {});
    if (child.pid !== undefined) this.launched.set(child.pid, { name, child });
    child.once("exit", () => {
      if (child.pid !== undefined) this.launched.delete(child.pid);
    });
    const before = (await this.read()).length;
    for (let i = 0; i < 100; i++) {
      await Promise.race([sleep(150), failed]);
      if (child.exitCode !== null && !this.launched.size)
        throw new ActionError(`${name} exited at once (code ${child.exitCode}).`);
      if ((await this.read()).length > before) return `Started ${name}.`;
    }
    return `Started ${name}, but no window of it has appeared yet.`;
  }

  /** The windows as text, as the agent reads them. */
  async observe(page = 1): Promise<string> {
    return renderDesktop(await this.read(), { page }).text;
  }

  /** Lines of the whole desktop, every page, that contain every word of the query. */
  async find(query: string): Promise<string> {
    const { lines } = renderDesktop(await this.read());
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = lines.filter((l) => words.every((w) => l.toLowerCase().includes(w)));
    if (!hits.length) return `Nothing on the desktop matches "${query}".`;
    const shown = hits.slice(0, 40).map((l) => l.trim());
    if (hits.length > 40) shown.push(`… ${hits.length - 40} more matches; narrow the query.`);
    return shown.join("\n");
  }

  /**
   * Clicks an element with the pointer, as a person would, when it is on the screen; else with its
   * own click or press action. The pointer comes first because an action runs inside the app's
   * accessibility handler, and an app that opens a modal dialog from there stops answering.
   */
  async click(ref: string, options: { double?: boolean } = {}): Promise<string> {
    const { address, info } = await this.resolve(ref);
    const label = describe(info, ref);
    const box = info.interfaces.has("org.a11y.atspi.Component")
      ? await this.atspi.extents(address).catch(() => undefined)
      : undefined;
    if (box && this.onScreen(box)) {
      await this.checkNotBlocked(address, label);
      const [x, y, width, height] = box;
      const [cx, cy] = [x + width / 2, y + height / 2];
      if (options.double) await this.atspi.mouse(cx, cy, "b1d");
      else {
        // Moved there first, then pressed and released apart: GTK menus ignore an instant click.
        await this.atspi.mouse(cx, cy, "abs");
        await sleep(30);
        await this.atspi.mouse(cx, cy, "b1p");
        await sleep(50);
        await this.atspi.mouse(cx, cy, "b1r");
      }
      return `${options.double ? "Double-clicked" : "Clicked"} ${label}.`;
    }
    if (info.interfaces.has("org.a11y.atspi.Action")) {
      const actions = await this.atspi.actions(address);
      const index =
        CLICKS.map((name) => actions.indexOf(name)).find((i) => i >= 0) ??
        (actions.length ? 0 : -1);
      if (index >= 0 && (await this.atspi.doAction(address, index))) return `Clicked ${label}.`;
    }
    throw new ActionError(`${label} can't be clicked: it is not on the screen and has no action.`);
  }

  /** Replaces the text in a field. With `submit`, activates it or presses Enter after. */
  async type(ref: string, text: string, options: { submit?: boolean } = {}): Promise<string> {
    const { address, info } = await this.resolve(ref);
    const label = describe(info, ref);
    if (info.interfaces.has("org.a11y.atspi.EditableText") && info.states.has("editable")) {
      if (!(await this.atspi.setText(address, text)))
        throw new ActionError(`${label} did not take the text.`);
    } else {
      if (!info.interfaces.has("org.a11y.atspi.Component"))
        throw new ActionError(`${label} is not a text field.`);
      await this.focus(address);
      await this.atspi.typeString(text);
    }
    if (options.submit) {
      await this.focus(address);
      await this.atspi.key("Enter");
      return `Typed into ${label} and pressed Enter.`;
    }
    return `Typed into ${label}.`;
  }

  /** Presses a key combo, into an element when given, else into whatever has the focus. */
  async press(keys: string, ref?: string): Promise<string> {
    if (ref) await this.focus((await this.resolve(ref)).address);
    try {
      await this.atspi.key(keys);
    } catch (error) {
      throw new ActionError(error instanceof Error ? error.message : String(error));
    }
    return `Pressed ${keys}${ref ? ` in ${ref}` : ""}.`;
  }

  /** Picks an option of a combo box or list by its visible name. */
  async select(ref: string, option: string): Promise<string> {
    const { address, info } = await this.resolve(ref);
    const label = describe(info, ref);
    const wanted = option.trim().toLowerCase();
    const found = await this.findDescendant(
      address,
      (child) => child.name.trim().toLowerCase() === wanted,
    );
    if (!found) throw new ActionError(`${label} has no option "${option}".`);
    // A combo box selects by the option's place among its options (GTK sets it active); a list
    // or tab list selects its own child.
    const owner = info.role === "combo box" ? address : found.parent;
    if (await this.trySelect(owner, found.index)) return `Selected "${option}" in ${label}.`;
    return this.click(this.refFor(found.info.address));
  }

  /** Waits until the windows stop changing, at most `timeoutMs`. */
  async settle(timeoutMs = 2_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    await sleep(100);
    let last = renderDesktop(await this.read()).text;
    while (Date.now() < end) {
      await sleep(150);
      const next = renderDesktop(await this.read()).text;
      if (next === last) return;
      last = next;
    }
  }

  /** The apps' visible windows, read from the accessibility bus. */
  async read(): Promise<DesktopWindow[]> {
    const atspi = this.atspi;
    const root = await atspi.info(atspi.root);
    const apps = await atspi.children(atspi.root, root.childCount, CHILD_LIMIT);
    let budget = NODE_LIMIT;
    const windows: DesktopWindow[] = [];
    const modals = new Set<string>();
    for (const appAddress of apps) {
      const app = await atspi.info(appAddress).catch(() => undefined);
      if (!app) continue;
      for (const address of await atspi.children(appAddress, app.childCount, CHILD_LIMIT)) {
        const info = await atspi.info(address).catch(() => undefined);
        if (!info || !WINDOWS.has(info.role) || !info.states.has("showing")) continue;
        const node = await this.readNode(info, () => budget-- > 0);
        windows.push({ app: app.name, node });
        if (info.states.has("modal")) modals.add(`${address.bus}${address.path}`);
      }
    }
    this.modals = modals;
    return windows;
  }

  private async readNode(info: Info, more: () => boolean): Promise<DesktopNode> {
    const node: DesktopNode = {
      role: info.role,
      name: info.name,
      states: info.states,
      actionable: ["Action", "EditableText", "Selection"].some((i) =>
        info.interfaces.has(`org.a11y.atspi.${i}`),
      ),
      ref: this.refFor(info.address),
      children: [],
    };
    if (info.text !== undefined) node.text = info.text;
    if (info.value !== undefined) node.value = info.value;
    if (info.columns) node.columns = info.columns;
    const limit = Math.min(CHILD_LIMIT, info.childCount);
    if (limit < info.childCount) node.unread = info.childCount - limit;
    const addresses = info.childCount
      ? await this.atspi.children(info.address, info.childCount, limit)
      : [];
    const children = await Promise.all(
      addresses.map((a) => this.atspi.info(a).catch(() => undefined)),
    );
    for (const child of children) {
      // Closed menus, hidden tabs and scrolled-away rows aren't on the screen.
      if (!child || !child.states.has("showing")) continue;
      if (!more()) {
        node.unread = (node.unread ?? 0) + 1;
        continue;
      }
      node.children.push(await this.readNode(child, more));
    }
    return node;
  }

  private onScreen([x, y, width, height]: readonly number[]): boolean {
    const size = this.options.size ?? { width: 1280, height: 800 };
    const [cx, cy] = [x! + width! / 2, y! + height! / 2];
    return width! > 0 && height! > 0 && cx >= 0 && cy >= 0 && cx < size.width && cy < size.height;
  }

  /** Refuses a click behind an open modal dialog, which would land on the dialog or nowhere. */
  private async checkNotBlocked(address: Address, label: string): Promise<void> {
    if (!this.modals.size) return;
    let window: Address | undefined = address;
    for (let i = 0; window && i < 50; i++) {
      if (this.modals.has(`${window.bus}${window.path}`)) return;
      window = await this.atspi.parent(window).catch(() => undefined);
    }
    throw new ActionError(`${label} is behind an open dialog. Handle the dialog first.`);
  }

  private refFor(address: Address): string {
    const key = `${address.bus}${address.path}`;
    let ref = this.refs.get(key);
    if (!ref) {
      ref = `e${this.refs.size + 1}`;
      this.refs.set(key, ref);
      this.addresses.set(ref, address);
    }
    return ref;
  }

  private async resolve(ref: string): Promise<{ address: Address; info: Info }> {
    const clean = ref
      .trim()
      .replace(/^\[|\]$/g, "")
      .replace(/^ref=/, "");
    const address = this.addresses.get(clean);
    if (!address)
      throw new ActionError(
        `There is no element ${ref}. Observe the desktop again for fresh refs.`,
      );
    const info = await this.atspi.info(address).catch(() => undefined);
    if (!info || info.states.has("defunct"))
      throw new ActionError(
        `${ref} is gone (its window closed or changed). Observe the desktop again.`,
      );
    return { address, info };
  }

  /** Gives an element the keyboard focus, and puts the pointer over it, which X needs without a window manager. */
  private async focus(address: Address): Promise<void> {
    const [x, y, width, height] = await this.atspi.extents(address).catch(() => [0, 0, 0, 0]);
    if (width > 0 && height > 0) await this.atspi.mouse(x + width / 2, y + height / 2, "abs");
    await this.atspi.grabFocus(address).catch(() => false);
  }

  private async trySelect(parent: Address, index: number): Promise<boolean> {
    const info = await this.atspi.info(parent).catch(() => undefined);
    if (!info?.interfaces.has("org.a11y.atspi.Selection")) return false;
    return this.atspi.selectChild(parent, index).catch(() => false);
  }

  /** The first descendant that matches, hidden or not (a closed combo box's options aren't showing). */
  private async findDescendant(
    root: Address,
    match: (info: Info) => boolean,
    depth = 0,
  ): Promise<{ info: Info; parent: Address; index: number } | undefined> {
    if (depth > 6) return undefined;
    const info = await this.atspi.info(root);
    const children = await this.atspi.children(root, info.childCount, CHILD_LIMIT);
    for (const [index, address] of children.entries()) {
      const child = await this.atspi.info(address).catch(() => undefined);
      if (!child) continue;
      if (match(child)) return { info: child, parent: root, index };
      const nested = await this.findDescendant(address, match, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }
}

function describe(info: Info, ref: string): string {
  return `${info.role}${info.name ? ` "${info.name}"` : ""} [${ref}]`;
}

function onPath(program: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, program)));
}

function kill(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    // Apps and the buses run in their own process groups, with whatever they started.
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

async function startXvfb(size: {
  width: number;
  height: number;
}): Promise<{ display: string; process: ChildProcess }> {
  for (let n = 140; n < 200; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    const display = `:${n}`;
    const child = spawn(
      "Xvfb",
      [display, "-screen", "0", `${size.width}x${size.height}x24`, "-nolisten", "tcp"],
      {
        stdio: "ignore",
        detached: true,
      },
    );
    for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${n}`); i++) {
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    if (existsSync(`/tmp/.X11-unix/X${n}`)) {
      process.once("exit", () => kill(child));
      return { display, process: child };
    }
    kill(child);
  }
  throw new Error("Could not start Xvfb for the desktop.");
}

/** A session bus for the desktop alone. It starts the accessibility bus when an app asks for it. */
async function startSessionBus(
  env: NodeJS.ProcessEnv,
  runtimeDir: string,
): Promise<{ address: string; process: ChildProcess }> {
  const child = spawn(
    "dbus-daemon",
    [
      "--session",
      "--nofork",
      "--print-address=1",
      `--address=unix:path=${join(runtimeDir, "bus")}`,
    ],
    { env, stdio: ["ignore", "pipe", "ignore"], detached: true },
  );
  process.once("exit", () => kill(child));
  const address = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("The desktop's D-Bus did not start.")), 5_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const first = out.split("\n")[0];
      if (out.includes("\n") && first) {
        clearTimeout(timer);
        resolve(first.trim());
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The desktop's D-Bus exited (code ${code}).`));
    });
  });
  return { address, process: child };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
