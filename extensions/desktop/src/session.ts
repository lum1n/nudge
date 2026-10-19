// A desktop of its own: a virtual display, a session bus and an accessibility bus, with the apps
// the settings allow, read and driven through AT-SPI. Nothing reaches the person's real session.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { type Address, Atspi, type Info } from "./atspi.ts";
import { type DesktopNode, type DesktopWindow, renderDesktop, roleOf } from "./snapshot.ts";

export interface DesktopOptions {
  /** The apps the agent may start, by name: the program and its arguments. */
  apps: Readonly<Record<string, readonly string[]>>;
  /** The desktop's home: the apps' settings and files stay here between sessions. */
  homeDir: string;
  size?: { width: number; height: number };
  /**
   * Runs the apps in a bubblewrap sandbox: they see the system's programs and libraries read-only,
   * the desktop's home and display, and nothing else of the machine (no other homes, no Nudge
   * data). `readable` adds directories they may read, such as where an app is unpacked.
   */
  sandbox?: { readable?: readonly string[] };
}

/** An action that could not be done, said so the agent can try something else. */
export class ActionError extends Error {}

/** The user's approval of one consequential action, from desktop_confirm; used up when taken. */
export interface Approval {
  granted: boolean;
}

const WINDOWS = new Set(["frame", "window", "dialog", "alert", "file chooser"]);
/** What Delete deletes the selected items of, outside documents: file views, mailboxes, lists. */
const ITEMS = new Set([
  "list",
  "list item",
  "tree",
  "tree item",
  "tree table",
  "table",
  "table row",
  "table cell",
  "icon",
  "layered pane",
]);
/** Objects shown outside any window the apps list: Qt's popup menus. */
const POPUPS = new Set(["menu", "popup menu", "window"]);
/** Most children read per node, and most nodes per observation. */
const CHILD_LIMIT = 300;
/** Most rows and columns of a spreadsheet read, from its top left corner on the screen. */
const GRID_ROWS = 60;
const GRID_COLUMNS = 26;
const NODE_LIMIT = 5_000;
/** Actions tried first when clicking, in order; else the first one the object has. */
const CLICKS = ["click", "press", "activate", "toggle", "jump", "open"];

/**
 * Why a desktop can't start here, if it can't: it needs Xvfb, D-Bus and AT-SPI, and bubblewrap
 * when the apps run sandboxed.
 */
export function desktopProblem(options: { sandbox?: boolean } = {}): string | undefined {
  const missing = ["Xvfb", "dbus-daemon"].filter((program) => !onPath(program));
  if (!a11yBusConfig()) missing.push("AT-SPI bus config");
  if (missing.length)
    return `This server has no ${missing.join(" or ")} for the desktop. Install xvfb, dbus and at-spi2-core.`;
  if (options.sandbox) return sandboxProblem();
  return undefined;
}

let sandboxChecked: { problem: string | undefined } | undefined;

/** Why apps can't run in a bubblewrap sandbox here, if they can't; checked once. */
export function sandboxProblem(): string | undefined {
  sandboxChecked ??= {
    problem: !onPath("bwrap")
      ? "This server has no bubblewrap (bwrap) to run the desktop's apps sandboxed. Install bubblewrap, or turn \"sandbox\" off in the desktop extension's settings to run them without one."
      : spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--unshare-pid", "true"], {
            stdio: "ignore",
            timeout: 5_000,
          }).status !== 0
        ? "bubblewrap can't make a sandbox on this server: it needs user namespaces, which this system or container doesn't allow (Docker's default seccomp profile blocks them). Allow them, or turn \"sandbox\" off in the desktop extension's settings to run the apps without one."
        : undefined,
  };
  return sandboxChecked.problem;
}

/** at-spi2-core's config for the accessibility bus, where at-spi-bus-launcher looks for it. */
function a11yBusConfig(): string | undefined {
  return ["/etc/at-spi2/accessibility.conf", "/usr/share/defaults/at-spi2/accessibility.conf"].find(
    (path) => existsSync(path),
  );
}

/**
 * What of Nudge's environment the desktop's buses and apps get: where programs are, the language
 * and time zone. The person's session (display, buses, desktop) and Nudge's keys stay out.
 */
const PASSED_ENV = /^(PATH|LANG|LANGUAGE|LC_[A-Z_]+|TZ|USER|LOGNAME|SHELL)$/;

/** Runtime directories of desktops are named so; `sweepDesktops` finds the ones left behind. */
const RUNTIME_PREFIX = "nudge-desktop-";

/**
 * Stops what desktops of processes that are gone left running, such as after a SIGKILL: their
 * Xvfb, buses and apps run detached, in process groups of their own, recorded in their runtime dir.
 */
export function sweepDesktops(dir = tmpdir()): number {
  let swept = 0;
  for (const name of readdirSync(dir).filter((n) => n.startsWith(RUNTIME_PREFIX))) {
    const runtimeDir = join(dir, name);
    const owner = Number(readOr(join(runtimeDir, "owner")).trim() || NaN);
    // One without an owner is from before owners were noted, or a moment old: gone after an hour.
    const stale = Number.isInteger(owner)
      ? !alive(owner)
      : Date.now() - (statSync(runtimeDir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) >
        3_600_000;
    if (!stale) continue;
    for (const entry of readOr(join(runtimeDir, "groups")).split("\n").filter(Boolean)) {
      const [pid, program] = entry.split(" ");
      // A recycled pid belongs to someone else: only a group still led by the same program goes.
      if (Number(pid) > 1 && program && commandOf(Number(pid)) === program) {
        try {
          process.kill(-Number(pid), "SIGTERM");
        } catch {}
      }
    }
    removeRuntimeDir(runtimeDir);
    swept++;
  }
  return swept;
}

export class DesktopSession {
  private readonly refs = new Map<string, string>();
  private readonly addresses = new Map<string, Address>();
  /** What each ref is, as of the last read, like `button "Save"`, for progress lines. */
  private readonly labels = new Map<string, string>();
  /** The window each ref is in, and the windows on the screen, as of the last read. */
  private readonly windowOf = new Map<string, Address>();
  private windows: Address[] = [];
  private readonly launched = new Map<number, { name: string; child: ChildProcess }>();
  /** The open modal dialogs, as of the last read. */
  private modals = new Set<string>();
  /**
   * Objects that said they were shown, by address: Qt leaves its popup menus out of the app's
   * windows, and they are found this way.
   */
  private readonly shown = new Map<string, Address>();
  /** What last said it got the keyboard. */
  focused: Address | undefined;
  /** The objects the last read reached. */
  private seen = new Set<string>();
  options: DesktopOptions;
  readonly display: string;
  /** The screen's pixels, as Xvfb keeps them in a file (XWD), for the live view. */
  framebuffer = "";
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
    const problem = desktopProblem({ sandbox: options.sandbox !== undefined });
    if (problem) throw new Error(problem);
    sweepDesktops();
    const processes: ChildProcess[] = [];
    const runtimeDir = mkdtempSync(join(tmpdir(), RUNTIME_PREFIX));
    writeFileSync(join(runtimeDir, "owner"), `${process.pid}\n`);
    try {
      const xvfb = await startXvfb(options.size ?? { width: 1280, height: 800 }, runtimeDir);
      processes.push(xvfb.process);
      record(runtimeDir, xvfb.process);
      mkdirSync(options.homeDir, { recursive: true });
      const base: NodeJS.ProcessEnv = {
        // Only what apps need of Nudge's own environment: not its keys and secrets.
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => PASSED_ENV.test(name)),
        ),
        DISPLAY: xvfb.display,
        HOME: options.homeDir,
        XDG_RUNTIME_DIR: runtimeDir,
        XDG_CONFIG_HOME: join(options.homeDir, ".config"),
        XDG_DATA_HOME: join(options.homeDir, ".local", "share"),
        XDG_CACHE_HOME: join(options.homeDir, ".cache"),
      };
      const bus = await startBus(base, runtimeDir, "bus", ["--session"]);
      processes.push(bus.process);
      record(runtimeDir, bus.process);
      // The accessibility bus too, on dbus-daemon: it starts the registry with this environment.
      const a11y = await startBus(
        { ...base, DBUS_SESSION_BUS_ADDRESS: bus.address },
        runtimeDir,
        "a11y-bus",
        [`--config-file=${a11yBusConfig()}`],
      );
      processes.push(a11y.process);
      record(runtimeDir, a11y.process);
      const env: NodeJS.ProcessEnv = {
        ...base,
        DBUS_SESSION_BUS_ADDRESS: bus.address,
        // GTK, Qt and libatspi take this before asking the session.
        AT_SPI_BUS_ADDRESS: a11y.address,
        GDK_BACKEND: "x11",
        QT_QPA_PLATFORM: "xcb",
        // Qt, Chromium and Electron only expose their tree when asked to.
        QT_ACCESSIBILITY: "1",
        QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
        ACCESSIBILITY_ENABLED: "1",
        GTK_A11Y: "atspi",
        // Dialogs from the apps themselves, not the host's portals: those open on the host's
        // terms, and the document portal mounts a file system of its own.
        GDK_DEBUG: "no-portals",
        GTK_USE_PORTAL: "0",
        QT_NO_XDG_DESKTOP_PORTAL: "1",
      };
      const atspi = await Atspi.connect(bus.address, a11y.address);
      const session = new DesktopSession(options, xvfb.display, env, atspi, runtimeDir, processes);
      session.framebuffer = join(runtimeDir, "fb", "Xvfb_screen0");
      await atspi.onEvents(
        ["object:state-changed:showing", "object:state-changed:focused"],
        (event, address, detail) => {
          if (detail !== 1) return;
          if (event === "object:state-changed:showing") session.noteShown(address);
          if (event === "object:state-changed:focused") session.focused = address;
        },
      );
      return session;
    } catch (error) {
      for (const child of processes) kill(child);
      rmSync(runtimeDir, { recursive: true, force: true });
      throw error;
    }
  }

  async close(): Promise<void> {
    this.atspi.close();
    const children = [...[...this.launched.values()].map((l) => l.child), ...this.processes];
    this.kill();
    // Services the bus started can still be writing into the runtime dir as they go.
    await Promise.race([Promise.all(children.map(exited)), sleep(2_000)]);
    removeRuntimeDir(this.runtimeDir);
  }

  /** Stops the apps, the buses and the display at once, for a process on its way out. */
  kill(): void {
    for (const { child } of this.launched.values()) kill(child);
    this.launched.clear();
    for (const child of this.processes.reverse()) kill(child);
    this.processes.length = 0;
    removeRuntimeDir(this.runtimeDir);
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
    const [program, ...args] = this.options.sandbox
      ? ["bwrap", ...this.sandboxArgs(this.options.sandbox), "--", ...command]
      : command;
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
    record(this.runtimeDir, child);
    child.once("exit", () => {
      if (child.pid !== undefined) this.launched.delete(child.pid);
    });
    const before = await this.windowCount();
    for (let i = 0; i < 100; i++) {
      await Promise.race([sleep(150), failed]);
      if (child.exitCode !== null && !this.launched.size)
        throw new ActionError(
          `${name} exited at once (code ${child.exitCode}).${this.options.sandbox ? " It runs in a sandbox that shows it only the system's programs and the desktop's home; if it is installed elsewhere, that directory belongs in the desktop extension's \"readable\" setting." : ""}`,
        );
      if ((await this.windowCount()) > before) return `Started ${name}.`;
    }
    return `Started ${name}, but no window of it has appeared yet.`;
  }

  /**
   * bubblewrap's arguments for an app: the system read-only, the desktop's home, display and
   * buses writable, an empty /tmp, and no other files of the machine. It shares the network, and
   * IPC for X's shared memory. It dies with Nudge.
   */
  private sandboxArgs(sandbox: NonNullable<DesktopOptions["sandbox"]>): string[] {
    const system = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt"];
    // Fonts' caches, and where /etc/resolv.conf points on systemd hosts.
    const extra = ["/var/cache/fontconfig", "/run/systemd/resolve", ...(sandbox.readable ?? [])];
    const socket = `/tmp/.X11-unix/X${this.display.slice(1)}`;
    return [
      "--die-with-parent",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-cgroup-try",
      ...system.flatMap((path) => ["--ro-bind-try", path, path]),
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/run",
      ...extra.flatMap((path) => ["--ro-bind-try", path, path]),
      "--bind",
      socket,
      socket,
      "--bind",
      this.runtimeDir,
      this.runtimeDir,
      "--bind",
      this.options.homeDir,
      this.options.homeDir,
      "--chdir",
      this.options.homeDir,
    ];
  }

  /** The windows on the screen, by title, with refs to bring them to the front; without reading into them. */
  async windowList(): Promise<{ ref: string; title: string; app: string }[]> {
    const atspi = this.atspi;
    const root = await atspi.info(atspi.root);
    const list: { ref: string; title: string; app: string }[] = [];
    for (const appAddress of await atspi.children(atspi.root, root.childCount, CHILD_LIMIT)) {
      const app = await atspi.info(appAddress).catch(() => undefined);
      if (!app) continue;
      for (const top of await atspi
        .children(appAddress, app.childCount, CHILD_LIMIT)
        .catch(() => [] as Address[])) {
        const window = await atspi.info(top).catch(() => undefined);
        if (window && WINDOWS.has(window.role) && window.states.has("showing"))
          list.push({ ref: this.refFor(top), title: window.name, app: app.name });
      }
    }
    return list;
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

  /** What a ref is, as of the last read, like `button "Save" [e12]`; the ref itself if unknown. */
  describe(ref: string): string {
    const label = this.labels.get(ref);
    return label === undefined ? ref : `${label} [${ref}]`;
  }

  /**
   * Brings a window to the front and puts the pointer over it, so it gets the keys: there is no
   * window manager, and X gives the keyboard to the window under the pointer.
   */
  async focusWindow(ref: string): Promise<string> {
    const { address, info } = await this.resolve(ref);
    const window = this.windowOf.get(this.refFor(address)) ?? address;
    const itself = this.refFor(window) === this.refFor(address);
    const top = itself ? info : await this.atspi.info(window);
    await this.raise(window, itself ? undefined : address);
    const [x, y, width, height] = await this.atspi.extents(window).catch(() => [0, 0, 0, 0]);
    if (width > 0 && height > 0) await this.atspi.mouse(x + width / 2, y + height / 2, "abs");
    return `Brought ${describe(top, this.refFor(window))} to the front.`;
  }

  /**
   * Clicks an element with the pointer, as a person would, when it is on the screen; else with its
   * own click or press action. The pointer comes first because an action runs inside the app's
   * accessibility handler, and an app that opens a modal dialog from there stops answering.
   */
  async click(ref: string, options: { double?: boolean } = {}): Promise<string> {
    const { address, info } = await this.resolve(ref);
    const label = describe(info, ref);
    // A menu bar's menus open by their own action: LibreOffice's Qt menu bar says they are a
    // menu bar's height lower than they are. Opening a menu can't block in the app's handler.
    if (!options.double && (await this.inMenuBar(address)) && (await this.doClickAction(address)))
      return `Clicked ${label}.`;
    const box = info.interfaces.has("org.a11y.atspi.Component")
      ? await this.screenBox(address).catch(() => undefined)
      : undefined;
    if (box && this.onScreen(box)) {
      await this.checkNotBlocked(address, label);
      const [x, y, width, height] = box;
      const [cx, cy] = [x + width / 2, y + height / 2];
      await this.raiseIfCovered(this.refFor(address), cx, cy);
      if (options.double) await this.atspi.mouse(cx, cy, "b1d");
      else await this.pointerClick(cx, cy);
      return `${options.double ? "Double-clicked" : "Clicked"} ${label}.`;
    }
    if (info.interfaces.has("org.a11y.atspi.Action") && (await this.doClickAction(address)))
      return `Clicked ${label}.`;
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
      await this.focusField(address, label);
      await this.atspi.typeString(text);
    }
    if (options.submit) {
      await this.focusField(address, label);
      await this.atspi.key("Enter");
      return `Typed into ${label} and pressed Enter.`;
    }
    return `Typed into ${label}.`;
  }

  /**
   * Presses a key combo, into an element when given, else into whatever has the focus. Delete on
   * an item of a list or tree deletes what is selected, like files in a file manager or mail in
   * a mailbox: that takes the user's approval, which it uses up. (In a document it only changes
   * the document, and saving over a file asks.)
   */
  async press(keys: string, ref?: string, approval?: Approval): Promise<string> {
    const target = ref ? await this.resolve(ref) : undefined;
    if (/^(shift\s*\+\s*)?delete$/i.test(keys.trim())) {
      const at =
        target?.info ??
        (this.focused && (await this.atspi.info(this.focused).catch(() => undefined)));
      if (at && (await this.holdsItems(at))) {
        if (!approval?.granted)
          throw new ActionError(
            `${keys} here deletes what is selected. Call desktop_confirm first, with what it deletes.`,
          );
        approval.granted = false;
      }
    }
    if (target) await this.focus(target.address);
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

  /**
   * How many windows are on the screen, without reading into them: LibreOffice aborts when its
   * window is read while it is still being built.
   */
  private async windowCount(): Promise<number> {
    const atspi = this.atspi;
    const root = await atspi.info(atspi.root);
    let count = 0;
    for (const app of await atspi.children(atspi.root, root.childCount, CHILD_LIMIT)) {
      const info = await atspi.info(app).catch(() => undefined);
      if (!info) continue;
      for (const top of await atspi.children(app, info.childCount, CHILD_LIMIT).catch(() => [])) {
        const window = await atspi.info(top).catch(() => undefined);
        if (window && WINDOWS.has(window.role) && window.states.has("showing")) count++;
      }
    }
    return count;
  }

  /** The apps' visible windows, read from the accessibility bus. */
  async read(): Promise<DesktopWindow[]> {
    const atspi = this.atspi;
    const root = await atspi.info(atspi.root);
    const apps = await atspi.children(atspi.root, root.childCount, CHILD_LIMIT);
    let budget = NODE_LIMIT;
    const windows: DesktopWindow[] = [];
    const tops: Address[] = [];
    const modals = new Set<string>();
    this.seen = new Set();
    for (const appAddress of apps) {
      const app = await atspi.info(appAddress).catch(() => undefined);
      if (!app) continue;
      // An app can leave the bus between the listing and its windows, such as a launcher.
      const appWindows = await atspi
        .children(appAddress, app.childCount, CHILD_LIMIT)
        .catch(() => [] as Address[]);
      for (const address of appWindows) {
        const info = await atspi.info(address).catch(() => undefined);
        if (!info || !WINDOWS.has(info.role) || !info.states.has("showing")) continue;
        const node = await this.readNode(info, () => budget-- > 0, address).catch(() => undefined);
        if (!node) continue;
        windows.push({ app: app.name, node });
        tops.push(address);
        if (info.states.has("modal")) modals.add(`${address.bus}${address.path}`);
      }
    }
    for await (const { info, app } of this.popups()) {
      const node = await this.readNode(info, () => budget-- > 0, info.address).catch(
        () => undefined,
      );
      if (!node) continue;
      windows.push({ app, node });
      tops.push(info.address);
    }
    const editing = await this.unseenField(tops, () => budget-- > 0);
    if (editing) windows.push(editing);
    this.modals = modals;
    this.windows = tops;
    return windows;
  }

  /**
   * The field that has the keyboard, when the read didn't reach it: some fields are in no
   * window's children, like the one Dolphin renames a file in. Its window is its app's.
   */
  private async unseenField(
    tops: readonly Address[],
    more: () => boolean,
  ): Promise<DesktopWindow | undefined> {
    const focused = this.focused;
    if (!focused || this.seen.has(`${focused.bus}${focused.path}`)) return undefined;
    const info = await this.atspi.info(focused).catch(() => undefined);
    if (!info?.states.has("editable") || !info.states.has("focused")) return undefined;
    if (!info.states.has("showing")) return undefined;
    const window = tops.find((top) => top.bus === focused.bus);
    if (!window) return undefined;
    const node = await this.readNode(info, more, window).catch(() => undefined);
    const app = await this.atspi.appName(focused).catch(() => "");
    return node && { app, node, editing: true };
  }

  private async readNode(
    info: Info,
    more: () => boolean,
    window: Address,
    /** A menu bar's menus: their items are read when they open, as popups or windows. */
    shallow = false,
  ): Promise<DesktopNode> {
    this.seen.add(`${info.address.bus}${info.address.path}`);
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
    this.labels.set(node.ref!, `${roleOf(node)}${node.name ? ` "${node.name}"` : ""}`);
    this.windowOf.set(node.ref!, window);
    if (shallow) return node;
    // A spreadsheet has more cells than can be read: the ones on the screen with something in them.
    if (info.columns && info.childCount > CHILD_LIMIT && info.states.has("manages-descendants"))
      return this.readGrid(info, node, more, window);
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
      // Qt says a closed menu's items are showing; an open one is selected (GTK) or expanded.
      const closed =
        info.role === "menu bar" && !child.states.has("selected") && !child.states.has("expanded");
      node.children.push(await this.readNode(child, more, window, closed));
    }
    return node;
  }

  /**
   * The cells of a big table that are on the screen and not empty, from the one at its top left
   * corner, as rows of cells: a spreadsheet has billions, most of them empty and out of view.
   */
  private async readGrid(
    info: Info,
    node: DesktopNode,
    more: () => boolean,
    window: Address,
  ): Promise<DesktopNode> {
    const atspi = this.atspi;
    const size = await atspi.tableSize(info.address);
    const [x, y] = await atspi.extents(info.address);
    const corner = await atspi.childAtPoint(info.address, x + 2, y + 2).catch(() => undefined);
    const start = corner
      ? await atspi.cellPosition(info.address, corner).catch(() => ({ row: 0, column: 0 }))
      : { row: 0, column: 0 };
    delete node.columns;
    let empty = 0;
    for (let row = start.row; row < Math.min(size.rows, start.row + GRID_ROWS); row++) {
      const cells = await Promise.all(
        Array.from({ length: Math.min(GRID_COLUMNS, size.columns - start.column) }, (_, i) =>
          atspi
            .cellAt(info.address, row, start.column + i)
            .then((cell) => atspi.info(cell))
            .catch(() => undefined),
        ),
      );
      const shown = cells.filter((cell) => cell?.states.has("showing"));
      // Past the bottom of the view.
      if (!shown.length) break;
      for (const cell of shown) {
        if (!cell!.text?.trim()) {
          empty++;
          continue;
        }
        if (!more()) break;
        node.children.push(await this.readNode(cell!, more, window));
      }
    }
    if (!node.children.length && empty) node.text = `${empty} empty cells on the screen`;
    return node;
  }

  /** Does an element's own click, press or first action, if it has one. */
  private async doClickAction(address: Address): Promise<boolean> {
    const actions = await this.atspi.actions(address).catch(() => [] as string[]);
    const index =
      CLICKS.map((name) => actions.indexOf(name)).find((i) => i >= 0) ?? (actions.length ? 0 : -1);
    return index >= 0 && this.atspi.doAction(address, index).catch(() => false);
  }

  /** Whether an element is a menu of a menu bar. */
  private async inMenuBar(address: Address): Promise<boolean> {
    const parent = await this.atspi.parent(address).catch(() => undefined);
    if (!parent) return false;
    return (await this.atspi.info(parent).catch(() => undefined))?.role === "menu bar";
  }

  /** Notes an object that was shown, for `popups`. */
  /**
   * Whether Delete on this deletes items: it is a list, tree or table, or one of their items,
   * outside a document. A spreadsheet's cells are in a document: Delete there clears them.
   */
  private async holdsItems(info: Info): Promise<boolean> {
    if (!ITEMS.has(info.role)) return false;
    let address: Address | undefined = info.address;
    for (let depth = 0; address && depth < 12; depth++) {
      address = await this.atspi.parent(address).catch(() => undefined);
      const parent = address && (await this.atspi.info(address).catch(() => undefined));
      if (parent?.role.startsWith("document")) return false;
    }
    return true;
  }

  noteShown(address: Address): void {
    const key = `${address.bus}${address.path}`;
    this.shown.delete(key);
    this.shown.set(key, address);
    // Most are buttons and labels coming into view; the oldest go first.
    if (this.shown.size > 500) this.shown.delete(this.shown.keys().next().value!);
  }

  /**
   * Menus on the screen that the read of the apps' windows didn't reach, with their app's name;
   * one at a time, as a submenu is reached through the menu before it.
   */
  private async *popups(): AsyncGenerator<{ info: Info; app: string }> {
    for (const [key, address] of this.shown) {
      if (this.seen.has(key)) continue;
      const info = await this.atspi.info(address).catch(() => undefined);
      // Shown again later, it says so again.
      if (!info || !POPUPS.has(info.role) || !info.states.has("showing")) {
        this.shown.delete(key);
        continue;
      }
      yield { info, app: await this.atspi.appName(address).catch(() => "") };
    }
  }

  /**
   * Where an element is on the screen. GTK 4 doesn't know where its windows are and says 0,0 for
   * everything, but knows where an element is in its window: that, from the window's corner. Its
   * window coordinates start outside the window, at the shadow, so the window's own are taken off.
   */
  private async screenBox(address: Address): Promise<[number, number, number, number]> {
    const box = await this.atspi.extents(address);
    if (box[0] !== 0 || box[1] !== 0) return box;
    const [x, y] = await this.atspi.extents(address, 1).catch(() => box);
    const window = this.windowOf.get(this.refFor(address));
    if ((x === 0 && y === 0) || !window) return box;
    const [wx, wy] = await this.atspi.extents(window).catch(() => [0, 0]);
    const [ox, oy] = await this.atspi.extents(window, 1).catch(() => [0, 0]);
    return [wx! + x - ox!, wy! + y - oy!, box[2], box[3]];
  }

  private onScreen([x, y, width, height]: readonly number[]): boolean {
    const size = this.options.size ?? { width: 1280, height: 800 };
    const [cx, cy] = [x! + width! / 2, y! + height! / 2];
    return width! > 0 && height! > 0 && cx >= 0 && cy >= 0 && cx < size.width && cy < size.height;
  }

  /**
   * Raises the window an element is in when another window covers the point: windows without a
   * window manager overlap where they open, and the click would land on the one on top.
   */
  private async raiseIfCovered(ref: string, x: number, y: number): Promise<void> {
    const own = this.windowOf.get(ref);
    if (!own) return;
    const key = `${own.bus}${own.path}`;
    for (const other of this.windows) {
      if (`${other.bus}${other.path}` === key) continue;
      const [ox, oy, w, h] = await this.atspi.extents(other).catch(() => [0, 0, 0, 0]);
      if (x >= ox && y >= oy && x < ox + w && y < oy + h) {
        await this.raise(own, this.addresses.get(ref));
        return;
      }
    }
  }

  /**
   * Raises a window. A window doesn't take the focus itself, but a control in it does, and its
   * toolkit presents the window then (GTK raises it): `element` if it can, else the first that can.
   */
  private async raise(window: Address, element?: Address): Promise<void> {
    const focus = (address: Address) => this.atspi.grabFocus(address).catch(() => false);
    if (!(element && (await focus(element)))) {
      const focusable = await this.findDescendant(
        window,
        (info) => info.states.has("focusable") && info.states.has("showing"),
      ).catch(() => undefined);
      if (!(focusable && (await focus(focusable.info.address)))) await focus(window);
    }
    await sleep(100);
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

  /**
   * Gives a text field the keyboard focus with a click, as a person would: Qt doesn't give a field
   * the keys when it is only asked to take the focus.
   */
  private async focusField(address: Address, label: string): Promise<void> {
    const box = await this.screenBox(address).catch(() => undefined);
    if (!box || !this.onScreen(box)) return this.focus(address);
    await this.checkNotBlocked(address, label);
    const [x, y, width, height] = box;
    const [cx, cy] = [x + width / 2, y + height / 2];
    await this.raiseIfCovered(this.refFor(address), cx, cy);
    await this.pointerClick(cx, cy);
    await this.atspi.grabFocus(address).catch(() => false);
  }

  /** Moves the pointer to a point, then presses and releases apart: GTK menus ignore an instant click. */
  private async pointerClick(x: number, y: number): Promise<void> {
    await this.atspi.mouse(x, y, "abs");
    await sleep(30);
    await this.atspi.mouse(x, y, "b1p");
    await sleep(50);
    await this.atspi.mouse(x, y, "b1r");
  }

  /** Gives an element the keyboard focus, and puts the pointer over it, which X needs without a window manager. */
  private async focus(address: Address): Promise<void> {
    const [x, y, width, height] = await this.screenBox(address).catch(() => [0, 0, 0, 0]);
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
  return `${roleOf(info)}${info.name ? ` "${info.name}"` : ""} [${ref}]`;
}

function onPath(program: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, program)));
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/**
 * Removes a desktop's runtime dir. The document portal, which the bus starts for apps, mounts a
 * FUSE file system in it (`doc`) that can't be removed, nor even read once the portal is gone,
 * until it is unmounted. Whatever can't go stays for `sweepDesktops`.
 */
function removeRuntimeDir(runtimeDir: string): void {
  const mounts = readOr("/proc/self/mounts")
    .split("\n")
    // Mount points escape spaces as \040; runtime dirs have none.
    .map((line) => line.split(" ")[1] ?? "")
    .filter((point) => point.startsWith(`${runtimeDir}/`));
  for (const point of mounts) {
    for (const program of ["fusermount3", "fusermount"]) {
      if (spawnSync(program, ["-u", "-z", point], { stdio: "ignore" }).status === 0) break;
    }
  }
  try {
    rmSync(runtimeDir, { recursive: true, force: true });
  } catch {}
}

/** Stops a child when this process exits, unless it is gone by then. */
function killOnExit(child: ChildProcess): void {
  const stop = () => kill(child);
  process.once("exit", stop);
  child.once("exit", () => process.off("exit", stop));
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

/**
 * Starts Xvfb on a free display. It keeps the screen in `<runtimeDir>/fb/Xvfb_screen0`, which the
 * live view reads.
 */
async function startXvfb(
  size: { width: number; height: number },
  runtimeDir: string,
): Promise<{ display: string; process: ChildProcess }> {
  const fbdir = join(runtimeDir, "fb");
  mkdirSync(fbdir, { recursive: true });
  for (let n = 140; n < 200; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    const display = `:${n}`;
    const child = spawn(
      "Xvfb",
      [
        display,
        "-screen",
        "0",
        `${size.width}x${size.height}x24`,
        "-fbdir",
        fbdir,
        "-nolisten",
        "tcp",
      ],
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
      killOnExit(child);
      return { display, process: child };
    }
    kill(child);
  }
  throw new Error("Could not start Xvfb for the desktop.");
}

/** A bus for the desktop alone, at `name` in its runtime dir: `config` picks which kind. */
async function startBus(
  env: NodeJS.ProcessEnv,
  runtimeDir: string,
  name: string,
  config: string[],
): Promise<{ address: string; process: ChildProcess }> {
  const child = spawn(
    "dbus-daemon",
    [...config, "--nofork", "--print-address=1", `--address=unix:path=${join(runtimeDir, name)}`],
    // Services it starts begin in its working dir: the desktop's home, not the server's.
    { env, cwd: env.HOME, stdio: ["ignore", "pipe", "ignore"], detached: true },
  );
  killOnExit(child);
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

/** Notes a process group a desktop started, for `sweepDesktops`: its leader's pid and program. */
function record(runtimeDir: string, child: ChildProcess): void {
  if (child.pid === undefined) return;
  const program = commandOf(child.pid);
  if (program) appendFileSync(join(runtimeDir, "groups"), `${child.pid} ${program}\n`);
}

/** The program a process runs, by its first argument's base name, if it is there (Linux). */
function commandOf(pid: number): string | undefined {
  const argv0 = readOr(`/proc/${pid}/cmdline`).split("\0")[0];
  return argv0 ? basename(argv0) : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
