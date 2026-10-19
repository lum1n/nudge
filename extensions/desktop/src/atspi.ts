// A small AT-SPI client over D-Bus: reads the accessibility tree of the apps on one display and
// acts on it. Spec: https://gitlab.gnome.org/GNOME/at-spi2-core (xml/*.xml).
import dbus from "@particle/dbus-next";

const { Message } = dbus;
type Bus = ReturnType<typeof dbus.sessionBus>;

const REGISTRY = "org.a11y.atspi.Registry";
const ROOT = "/org/a11y/atspi/accessible/root";
const DEC = "/org/a11y/atspi/registry/deviceeventcontroller";
const ACCESSIBLE = "org.a11y.atspi.Accessible";
const ACTION = "org.a11y.atspi.Action";
const TABLE = "org.a11y.atspi.Table";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const CALL_TIMEOUT_MS = 3_000;

/** An accessible object: the app's bus name and the object's path on it. */
export interface Address {
  bus: string;
  path: string;
}

/** AT-SPI states (`AtspiStateType`), by bit. */
const STATES = [
  "invalid",
  "active",
  "armed",
  "busy",
  "checked",
  "collapsed",
  "defunct",
  "editable",
  "enabled",
  "expandable",
  "expanded",
  "focusable",
  "focused",
  "has-tooltip",
  "horizontal",
  "iconified",
  "modal",
  "multi-line",
  "multiselectable",
  "opaque",
  "pressed",
  "resizable",
  "selectable",
  "selected",
  "sensitive",
  "showing",
  "single-line",
  "stale",
  "transient",
  "vertical",
  "visible",
  "manages-descendants",
  "indeterminate",
  "required",
  "truncated",
  "animated",
  "invalid-entry",
  "supports-autocompletion",
  "selectable-text",
  "is-default",
  "visited",
  "checkable",
  "has-popup",
  "read-only",
] as const;
export type State = (typeof STATES)[number];

/** What one accessible says about itself, without its children's details. */
export interface Info {
  address: Address;
  role: string;
  name: string;
  description: string;
  states: Set<State>;
  interfaces: Set<string>;
  childCount: number;
  /** The text of a text object (fields, documents, some labels), when it has the Text interface. */
  text?: string;
  /** The current value of a slider, spin button or progress bar. */
  value?: number;
  /** Columns of a table, which lists its cells row by row. */
  columns?: number;
}

/** Keyboard modifiers as X modifier bits, for locking around a key. */
const MODIFIERS: Record<string, number> = {
  shift: 1,
  ctrl: 4,
  control: 4,
  alt: 8,
  super: 64,
  meta: 64,
};

/** Key names the agent may use, as X keysyms. Single characters map to their own keysym. */
const KEYSYMS: Record<string, number> = {
  enter: 0xff0d,
  return: 0xff0d,
  tab: 0xff09,
  escape: 0xff1b,
  esc: 0xff1b,
  backspace: 0xff08,
  delete: 0xffff,
  space: 0x20,
  home: 0xff50,
  end: 0xff57,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  pageup: 0xff55,
  pagedown: 0xff56,
  insert: 0xff63,
  menu: 0xff67,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0xffbe + i])),
};

/** The keysym and modifier mask for a combo like `ctrl+shift+s` or `Enter`. */
export function parseKeys(combo: string): { keysym: number; modifiers: number } {
  const parts = combo
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error(`No key in "${combo}".`);
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier "${part}" in "${combo}".`);
    modifiers |= bit;
  }
  const named = KEYSYMS[key.toLowerCase()];
  if (named !== undefined) return { keysym: named, modifiers };
  if ([...key].length !== 1) throw new Error(`Unknown key "${key}" in "${combo}".`);
  const code = key.codePointAt(0)!;
  // Latin-1 keysyms are the code points; others are 0x01000000 + the code point.
  const keysym =
    code < 0x100 ? (modifiers ? key.toLowerCase().codePointAt(0)! : code) : 0x01000000 + code;
  return { keysym, modifiers };
}

/** `org.a11y.Bus`, as at-spi-bus-launcher serves it: where the accessibility bus is. */
class A11yBus extends dbus.interface.Interface {
  readonly address: string;

  constructor(address: string) {
    super("org.a11y.Bus");
    this.address = address;
  }

  GetAddress(): string {
    return this.address;
  }
}
A11yBus.configureMembers({ methods: { GetAddress: { inSignature: "", outSignature: "s" } } });

/** `org.a11y.Status`: assistive technology is on, always, so toolkits expose their trees. */
class A11yStatus extends dbus.interface.Interface {
  IsEnabled = true;
  ScreenReaderEnabled = false;

  constructor() {
    super("org.a11y.Status");
  }
}
A11yStatus.configureMembers({
  properties: { IsEnabled: { signature: "b" }, ScreenReaderEnabled: { signature: "b" } },
});

export class Atspi {
  private readonly bus: Bus;
  private readonly session: Bus;

  private constructor(bus: Bus, session: Bus) {
    this.bus = bus;
    this.session = session;
  }

  /**
   * Connects to the accessibility bus at `a11yAddress`, and serves `org.a11y.Bus` on the session
   * at `sessionAddress`: apps that ask the session for the accessibility bus get that one, and
   * hear that assistive technology is on (Qt and Chromium wait for that). Serving it keeps
   * at-spi-bus-launcher from starting: inside a systemd user unit it runs the bus on dbus-broker,
   * which starts the registry as a unit of the person's own session, where it fails.
   */
  static async connect(sessionAddress: string, a11yAddress: string): Promise<Atspi> {
    const session = dbus.sessionBus({ busAddress: sessionAddress });
    try {
      session.export("/org/a11y/bus", new A11yBus(a11yAddress));
      session.export("/org/a11y/bus", new A11yStatus());
      // 4: don't queue. 1: now the primary owner.
      if ((await session.requestName("org.a11y.Bus", 4)) !== 1)
        throw new Error("The desktop's session already has an accessibility bus.");
      return new Atspi(dbus.sessionBus({ busAddress: a11yAddress }), session);
    } catch (error) {
      session.disconnect();
      throw error;
    }
  }

  close(): void {
    this.bus.disconnect();
    this.session.disconnect();
  }

  /**
   * Hears the apps' object and window events: `event` like `object:state-changed:showing`, the
   * object it is about, and its first detail. Apps only send the events someone registered for.
   */
  async onEvents(
    events: readonly string[],
    listener: (event: string, source: Address, detail: number) => void,
  ): Promise<void> {
    // object:… events come on Event.Object, window:… on Event.Window.
    const kinds = new Set(events.map((e) => e.split(":")[0]!));
    for (const kind of kinds)
      await call(
        this.bus,
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "AddMatch",
        "s",
        [
          `type='signal',interface='org.a11y.atspi.Event.${kind[0]!.toUpperCase()}${kind.slice(1)}'`,
        ],
      );
    for (const event of events) {
      // Newer registries also take the properties to cache and the app; older ones the event alone.
      await call(
        this.bus,
        REGISTRY,
        "/org/a11y/atspi/registry",
        "org.a11y.atspi.Registry",
        "RegisterEvent",
        "sass",
        [event, [], ""],
      ).catch(() =>
        call(
          this.bus,
          REGISTRY,
          "/org/a11y/atspi/registry",
          "org.a11y.atspi.Registry",
          "RegisterEvent",
          "s",
          [event],
        ),
      );
    }
    this.bus.on("message", (message: InstanceType<typeof Message>) => {
      const iface = message.interface ?? "";
      if (!iface.startsWith("org.a11y.atspi.Event.") || !message.sender || !message.path) return;
      const kind = iface.slice("org.a11y.atspi.Event.".length).toLowerCase();
      const member = String(message.member ?? "").replace(
        /[A-Z]/g,
        (c, i) => `${i ? "-" : ""}${c.toLowerCase()}`,
      );
      const [minor, detail] = (message.body ?? []) as [string?, number?];
      listener(
        `${kind}:${member}${minor ? `:${minor}` : ""}`,
        { bus: message.sender, path: message.path },
        Number(detail ?? 0),
      );
    });
  }

  /** The desktop: its children are the apps on the bus. */
  get root(): Address {
    return { bus: REGISTRY, path: ROOT };
  }

  async info(address: Address): Promise<Info> {
    const [[role = ""], [props = {}], [state = []], [interfaces = []]] = (await Promise.all([
      this.call(address, ACCESSIBLE, "GetRoleName"),
      this.allProperties(address),
      this.call(address, ACCESSIBLE, "GetState"),
      this.call(address, ACCESSIBLE, "GetInterfaces"),
    ])) as unknown as [[string?], [Record<string, { value: unknown }>?], [number[]?], [string[]?]];
    const info: Info = {
      address,
      role: role,
      name: String(props.Name?.value ?? ""),
      description: String(props.Description?.value ?? ""),
      states: states(state),
      interfaces: new Set(interfaces),
      childCount: Number(props.ChildCount?.value ?? 0),
    };
    // GTK 4 gives most of its containers an Action interface without a single action.
    if (
      info.interfaces.has(ACTION) &&
      Number(await this.property(address, ACTION, "NActions").catch(() => 1)) === 0
    )
      info.interfaces.delete(ACTION);
    // Fields are often named by a label beside them, linked as LABELLED_BY (2).
    if (!info.name && [...info.interfaces].some((i) => /EditableText|Action|Selection/.test(i)))
      info.name = await this.labelOf(address).catch(() => "");
    // A combo box is named by the option it shows; its label says what it is for.
    else if (role === "combo box") {
      const label = await this.labelOf(address).catch(() => "");
      if (label && label !== info.name) [info.name, info.text] = [label, info.name];
    }
    if (info.interfaces.has("org.a11y.atspi.Text")) {
      const [text] = (await this.call(
        address,
        "org.a11y.atspi.Text",
        "GetText",
        "ii",
        [0, -1],
      )) as [string];
      info.text = text;
    }
    if (info.interfaces.has("org.a11y.atspi.Value")) {
      info.value = Number(await this.property(address, "org.a11y.atspi.Value", "CurrentValue"));
    }
    if (info.interfaces.has("org.a11y.atspi.Table")) {
      info.columns = Number(
        await this.property(address, "org.a11y.atspi.Table", "NColumns").catch(() => 0),
      );
    }
    return info;
  }

  /** The Accessible properties, one by one where GetAll isn't answered (Qt). */
  private async allProperties(address: Address): Promise<[Record<string, { value: unknown }>]> {
    try {
      return (await this.call(address, PROPERTIES, "GetAll", "s", [ACCESSIBLE])) as [
        Record<string, { value: unknown }>,
      ];
    } catch {
      const names = ["Name", "Description", "ChildCount"];
      const values = await Promise.all(
        names.map((name) => this.property(address, ACCESSIBLE, name).catch(() => undefined)),
      );
      return [Object.fromEntries(names.map((name, i) => [name, { value: values[i] }]))];
    }
  }

  /** The name of the app an object belongs to. */
  async appName(address: Address): Promise<string> {
    const [[bus, path]] = (await this.call(address, ACCESSIBLE, "GetApplication")) as [
      [string, string],
    ];
    return String(await this.property({ bus, path }, ACCESSIBLE, "Name"));
  }

  /** The object's parent, or undefined at the top. */
  async parent(address: Address): Promise<Address | undefined> {
    const [bus, path] = (await this.property(address, ACCESSIBLE, "Parent")) as [string, string];
    if (!bus || path === "/org/a11y/atspi/null") return undefined;
    return { bus, path };
  }

  private async labelOf(address: Address): Promise<string> {
    const [relations] = (await this.call(address, ACCESSIBLE, "GetRelationSet")) as [
      [number, [string, string][]][],
    ];
    const labels = relations.filter(([type]) => type === 2).flatMap(([, targets]) => targets);
    // GTK 4 labels some controls with a nameless object that only has the text.
    const names = await Promise.all(
      labels.map(async ([bus, path]) => {
        const name = String(await this.property({ bus, path }, ACCESSIBLE, "Name"));
        if (name) return name;
        const [text] = (await this.call(
          { bus, path },
          "org.a11y.atspi.Text",
          "GetText",
          "ii",
          [0, -1],
        ).catch(() => [""])) as [string];
        return text;
      }),
    );
    return names.join(" ").trim();
  }

  /**
   * The first `limit` children of an object. Containers that manage their descendants, such as a
   * spreadsheet's table, may have millions; only the first ones are asked for.
   */
  async children(address: Address, count: number, limit: number): Promise<Address[]> {
    if (count <= limit) {
      const [children] = (await this.call(address, ACCESSIBLE, "GetChildren")) as [
        [string, string][],
      ];
      return children.map(([bus, path]) => ({ bus, path }));
    }
    const picked = (await Promise.all(
      Array.from({ length: limit }, (_, i) =>
        this.call(address, ACCESSIBLE, "GetChildAtIndex", "i", [i]),
      ),
    )) as [[string, string]][];
    return picked.map(([[bus, path]]) => ({ bus, path }));
  }

  /** The names of the actions an object offers, such as `click`, `activate` or `toggle`. */
  async actions(address: Address): Promise<string[]> {
    const [actions] = (await this.call(address, ACTION, "GetActions")) as [
      [string, string, string][],
    ];
    // GTK names them "Click" and "Press", Qt "Press", others lower case.
    return actions.map(([name]) => name.toLowerCase());
  }

  async doAction(address: Address, index: number): Promise<boolean> {
    const [done] = (await this.call(address, ACTION, "DoAction", "i", [index])) as [boolean];
    return done;
  }

  async setText(address: Address, text: string): Promise<boolean> {
    const [done] = (await this.call(
      address,
      "org.a11y.atspi.EditableText",
      "SetTextContents",
      "s",
      [text],
    )) as [boolean];
    return done;
  }

  async grabFocus(address: Address): Promise<boolean> {
    const [done] = (await this.call(address, "org.a11y.atspi.Component", "GrabFocus")) as [boolean];
    return done;
  }

  /** A table's size in rows and columns. */
  async tableSize(address: Address): Promise<{ rows: number; columns: number }> {
    const [rows, columns] = await Promise.all(
      ["NRows", "NColumns"].map((name) => this.property(address, TABLE, name).then(Number)),
    );
    return { rows: rows!, columns: columns! };
  }

  /** The cell of a table at a row and column. */
  async cellAt(address: Address, row: number, column: number): Promise<Address> {
    const [[bus, path]] = (await this.call(address, TABLE, "GetAccessibleAt", "ii", [
      row,
      column,
    ])) as [[string, string]];
    return { bus, path };
  }

  /** The row and column of a table's cell. */
  async cellPosition(table: Address, cell: Address): Promise<{ row: number; column: number }> {
    const [index] = (await this.call(cell, ACCESSIBLE, "GetIndexInParent")) as [number];
    const [[row], [column]] = (await Promise.all([
      this.call(table, TABLE, "GetRowAtIndex", "i", [index]),
      this.call(table, TABLE, "GetColumnAtIndex", "i", [index]),
    ])) as [[number], [number]];
    return { row, column };
  }

  /** The child of an object at a point on the screen. */
  async childAtPoint(address: Address, x: number, y: number): Promise<Address | undefined> {
    const [[bus, path]] = (await this.call(
      address,
      "org.a11y.atspi.Component",
      "GetAccessibleAtPoint",
      "iiu",
      [Math.round(x), Math.round(y), 0],
    )) as [[string, string]];
    return path === "/org/a11y/atspi/null" ? undefined : { bus, path };
  }

  /** Selects the `index`th child of a list, tab list or combo box. */
  async selectChild(address: Address, index: number): Promise<boolean> {
    const [done] = (await this.call(address, "org.a11y.atspi.Selection", "SelectChild", "i", [
      index,
    ])) as [boolean];
    return done;
  }

  /** Where an object is on the screen: x, y, width, height. */
  async extents(address: Address, coords: 0 | 1 = 0): Promise<[number, number, number, number]> {
    const [box] = (await this.call(address, "org.a11y.atspi.Component", "GetExtents", "u", [
      coords,
    ])) as [[number, number, number, number]];
    return box;
  }

  /** Presses a key combo, like `ctrl+s`, into whatever has the keyboard focus. */
  async key(combo: string): Promise<void> {
    const { keysym, modifiers } = parseKeys(combo);
    if (modifiers) await this.keyboard(modifiers, "", 5);
    try {
      await this.keyboard(keysym, "", 3);
    } finally {
      if (modifiers) await this.keyboard(modifiers, "", 6);
    }
  }

  /** Types a string into whatever has the keyboard focus. */
  async typeString(text: string): Promise<void> {
    await this.keyboard(0, text, 4);
  }

  /** A mouse event at screen coordinates: `b1c` clicks, `b1d` double-clicks, `abs` only moves. */
  async mouse(x: number, y: number, event: string): Promise<void> {
    await this.call(
      { bus: REGISTRY, path: DEC },
      "org.a11y.atspi.DeviceEventController",
      "GenerateMouseEvent",
      "iis",
      [Math.round(x), Math.round(y), event],
    );
  }

  private async keyboard(keycode: number, keystring: string, type: number): Promise<void> {
    await this.call(
      { bus: REGISTRY, path: DEC },
      "org.a11y.atspi.DeviceEventController",
      "GenerateKeyboardEvent",
      "isu",
      [keycode, keystring, type],
    );
  }

  private async property(address: Address, iface: string, name: string): Promise<unknown> {
    const [variant] = (await this.call(address, PROPERTIES, "Get", "ss", [iface, name])) as [
      { value: unknown },
    ];
    return variant.value;
  }

  private call(
    address: Address,
    iface: string,
    member: string,
    signature?: string,
    body?: unknown[],
  ) {
    return call(this.bus, address.bus, address.path, iface, member, signature, body);
  }
}

async function call(
  bus: Bus,
  destination: string,
  path: string,
  iface: string,
  member: string,
  signature?: string,
  body?: unknown[],
): Promise<unknown[]> {
  const sent = bus.call(
    new Message({
      destination,
      path,
      interface: iface,
      member,
      ...(signature ? { signature, body: body ?? [] } : {}),
    }),
  );
  // An app stuck in a modal loop, or gone, may never answer.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${member} on ${destination}${path} timed out`)),
      CALL_TIMEOUT_MS,
    );
  });
  try {
    const reply = await Promise.race([sent, timeout]);
    return (reply?.body ?? []) as unknown[];
  } finally {
    clearTimeout(timer);
  }
}

function states([low = 0, high = 0]: number[]): Set<State> {
  const set = new Set<State>();
  STATES.forEach((name, bit) => {
    const word = bit < 32 ? low : high;
    if ((word >>> (bit % 32)) & 1) set.add(name);
  });
  return set;
}
