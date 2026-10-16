import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Locator, type Page, type Request } from "patchright";
import type { SavedLogin } from "./logins.ts";
import { compactSnapshot, findLines } from "./snapshot.ts";

// Page-side globals for the functions passed to `evaluate`; this package compiles without the DOM lib.
declare const document: {
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<{ value: string }>;
};
declare const window: { scrollY: number };
declare const MutationObserver: new (callback: () => void) => {
  observe(target: unknown, options: Record<string, boolean>): void;
  disconnect(): void;
};
interface PageInput {
  labels?: ArrayLike<{ id: string }> | null;
}

export interface BrowserOptions {
  /** Persistent profile directory: cookies and logins survive restarts. */
  profileDir: string;
  /** Headed by default, because many sites block headless browsers. */
  headless?: boolean;
  viewport?: { width: number; height: number };
  locale?: string;
  /** Character budget for one observation. */
  budget?: number;
  /** Refuse localhost, private and link-local addresses and `.local` names, for pages and their requests. */
  blockPrivateNetwork?: boolean;
}

/** A failure the model should read and recover from, not a crash. */
export class ActionError extends Error {}

const SETTLE_CAP_MS = 6_000;
const DOM_QUIET_MS = 400;
const NETWORK_TYPES = new Set(["document", "xhr", "fetch", "script"]);

export class BrowserSession {
  private current: Page;
  private inflight = new Set<Request>();
  private lastLines: string[] = [];
  private notes: string[] = [];
  /** Saved logins this session may fill in, by host. */
  private findLogin: (host: string) => SavedLogin | undefined = () => undefined;
  /** Credential values never shown to the model, wherever they appear. */
  private scrubbed = new Set<string>();
  /** What the user typed into login forms in the live view, by host, not yet saved. */
  private captured = new Map<string, { username?: string; password?: string }>();
  private pageListeners = new Set<(page: Page) => void>();
  /** Query parameter names seen per host, in visited URLs and in links on observed pages. */
  private seenParams = new Map<string, Set<string>>();

  readonly context: BrowserContext;
  private readonly options: BrowserOptions;
  private readonly xvfb: ChildProcess | undefined;

  private constructor(
    context: BrowserContext,
    options: BrowserOptions,
    xvfb: ChildProcess | undefined,
  ) {
    this.context = context;
    this.options = options;
    this.xvfb = xvfb;
    this.current = context.pages()[0]!;
    for (const page of context.pages()) this.track(page);
    context.on("page", (page) => {
      this.track(page);
      this.setCurrent(page);
      this.notes.push("A new tab opened and is now the current tab.");
    });
  }

  static async open(options: BrowserOptions): Promise<BrowserSession> {
    const headless = options.headless ?? false;
    const xvfb = !headless && !process.env.DISPLAY ? await startXvfb(options.viewport) : undefined;
    const viewport = options.viewport ?? { width: 1280, height: 900 };
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless,
      viewport,
      locale: options.locale ?? "nb-NO",
      ...(xvfb ? { env: { ...process.env, DISPLAY: xvfb.display } } : {}),
    });
    if (options.blockPrivateNetwork)
      await context.route("**/*", (route) =>
        isPrivateHost(hostOf(route.request().url()))
          ? route.abort("blockedbyclient")
          : route.continue(),
      );
    if (!context.pages().length) await context.newPage();
    return new BrowserSession(context, options, xvfb?.process);
  }

  get page(): Page {
    return this.current;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    this.xvfb?.kill();
  }

  private track(page: Page): void {
    page.on("request", (r) => {
      if (NETWORK_TYPES.has(r.resourceType())) this.inflight.add(r);
    });
    const done = (r: Request) => this.inflight.delete(r);
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    page.on("close", () => {
      const open = this.context.pages();
      if (this.current === page && open.length) this.setCurrent(open[open.length - 1]!);
    });
  }

  /** Wait until navigation, network and DOM have gone quiet, or the cap passes. */
  async settle(capMs = SETTLE_CAP_MS): Promise<void> {
    const start = Date.now();
    const left = () => Math.max(0, capMs - (Date.now() - start));
    await this.current.waitForLoadState("domcontentloaded", { timeout: left() }).catch(() => {});
    let quietSince = Date.now();
    while (left() > 0) {
      if (this.inflight.size) quietSince = Date.now();
      else if (Date.now() - quietSince >= 300) break;
      await sleep(100);
    }
    await this.current
      .evaluate(
        ({ quiet, cap }) =>
          new Promise<void>((resolve) => {
            let last = performance.now();
            const begin = last;
            const observer = new MutationObserver(() => {
              last = performance.now();
            });
            observer.observe(document, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
            const tick = () => {
              const now = performance.now();
              const busy = document.querySelector('[aria-busy="true"]');
              if ((now - last >= quiet && !busy) || now - begin >= cap) {
                observer.disconnect();
                resolve();
              } else setTimeout(tick, 100);
            };
            setTimeout(tick, 100);
          }),
        { quiet: DOM_QUIET_MS, cap: Math.max(500, left()) },
      )
      .catch(() => {});
  }

  /** The page as compacted text, with URL, title and tabs on top. */
  async observe(page = 1): Promise<string> {
    const raw = scrub(
      hideSecrets(await this.current.ariaSnapshot({ mode: "ai" }), await this.secretValues()),
      this.scrubbed,
    );
    const snapshot = compactSnapshot(raw, { budget: this.options.budget ?? 24_000, page });
    this.lastLines = snapshot.lines;
    this.learnParams(this.current.url());
    for (const line of snapshot.lines) {
      const href = / → (\S+)/.exec(line)?.[1];
      if (href) this.learnParams(href, this.current.url());
    }
    const tabs = this.context.pages();
    const header = [
      `URL: ${this.current.url()}`,
      `Title: ${await this.current.title().catch(() => "")}`,
      tabs.length > 1
        ? `Tabs: ${tabs.length} (current is ${tabs.indexOf(this.current) + 1})`
        : undefined,
    ].filter(Boolean);
    return [...header, "", snapshot.text].join("\n");
  }

  private setCurrent(page: Page): void {
    this.current = page;
    for (const listener of this.pageListeners) listener(page);
  }

  /** Calls `listener` whenever another tab becomes the current one. */
  onPageChange(listener: (page: Page) => void): () => void {
    this.pageListeners.add(listener);
    return () => this.pageListeners.delete(listener);
  }

  /** Where saved logins come from, and the values to keep from the model from now on. */
  useLogins(find: (host: string) => SavedLogin | undefined, secrets: readonly string[]): void {
    this.findLogin = find;
    for (const value of secrets) if (value) this.scrubbed.add(value);
  }

  /** Reads the login fields of every frame and keeps what the user typed, per host. */
  async captureLogin(): Promise<void> {
    for (const frame of this.current.frames()) {
      const fields = (await frame.evaluate(LOGIN_FIELDS).catch(() => undefined)) as
        | { host: string; username: string; password: string }
        | undefined;
      if (!fields?.host || (!fields.username && !fields.password)) continue;
      const entry = this.captured.get(fields.host) ?? {};
      if (fields.username) entry.username = fields.username;
      if (fields.password) entry.password = fields.password;
      this.captured.set(fields.host, entry);
    }
  }

  /** Logins typed in the live view since the last call: a password, and the username if seen. */
  takeCaptured(): { host: string; username?: string; password: string }[] {
    const logins = [...this.captured].flatMap(([host, { username, password }]) => {
      if (!password) return [];
      // A two-step login asks for the username on one host and the password on another.
      const user = username ?? [...this.captured.values()].find((c) => c.username)?.username;
      return [{ host, password, ...(user ? { username: user } : {}) }];
    });
    this.captured.clear();
    for (const login of logins) {
      this.scrubbed.add(login.password);
      if (login.username) this.scrubbed.add(login.username);
    }
    return logins;
  }

  /** Fills a saved login into the login form of the frame whose host it was saved for. */
  async login(): Promise<string> {
    const hosts: string[] = [];
    for (const frame of this.current.frames()) {
      let host: string;
      try {
        host = new URL(frame.url()).hostname;
      } catch {
        continue;
      }
      const password = frame.locator("input[type=password]:visible").first();
      const username = frame.locator(USERNAME_FIELDS).first();
      const hasPassword = (await password.count()) > 0;
      const hasUsername = (await username.count()) > 0;
      if (!hasPassword && !hasUsername) continue;
      hosts.push(host);
      const saved = this.findLogin(host);
      if (saved === undefined) continue;
      if (saved.username) this.scrubbed.add(saved.username);
      this.scrubbed.add(saved.password);
      if (hasPassword) {
        if (saved.username && hasUsername && (await username.inputValue()) !== saved.username)
          await username.fill(saved.username, { timeout: 4_000 });
        await password.fill(saved.password, { timeout: 4_000 });
        await password.press("Enter");
        return `Filled in the saved login for ${host} and submitted it.`;
      }
      if (saved.username && hasUsername) {
        await username.fill(saved.username, { timeout: 4_000 });
        await username.press("Enter");
        return `Filled in the saved username and went on. Call browser_login again when the password field shows.`;
      }
    }
    if (!hosts.length) throw new ActionError("There is no login form on this page.");
    throw new ActionError(
      `There is no saved login for ${[...new Set(hosts)].join(", ")}. Call browser_request_login so the user can log in.`,
    );
  }

  /** What password, one-time-code and card fields hold now, in every frame. */
  private async secretValues(): Promise<string[]> {
    const values = await Promise.all(
      this.current
        .frames()
        .map((frame) =>
          frame
            .evaluate(
              (selector) => Array.from(document.querySelectorAll(selector), (input) => input.value),
              SECRET_FIELDS,
            )
            .catch(() => [] as string[]),
        ),
    );
    return values.flat().filter(Boolean);
  }

  async find(query: string): Promise<string> {
    if (!this.lastLines.length) await this.observe();
    const hits = findLines(this.lastLines, query);
    return hits.length ? hits.join("\n") : `Nothing on the page matches "${query}".`;
  }

  /** Notes about side effects (new tabs) since the last call. */
  takeNotes(): string[] {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }

  describe(ref: string): string {
    const line = this.lastLines.find((l) => l.includes(`[${ref}]`));
    return line ? line.trim().replace(/^- /, "").slice(0, 120) : ref;
  }

  private async locate(given: string): Promise<Locator> {
    const ref = /(f\d+)?e\d+/.exec(given)?.[0];
    if (!ref) {
      throw new ActionError(
        `"${given}" is not a ref. Use a ref like e12 from the latest observation.`,
      );
    }
    const locator = this.current.locator(`aria-ref=${ref}`);
    if ((await locator.count().catch(() => 0)) === 0) {
      throw new ActionError(
        `${ref} is no longer on the page (it changed). Observe again and use a fresh ref.`,
      );
    }
    return locator;
  }

  async click(ref: string, options: { double?: boolean } = {}): Promise<string> {
    const locator = await this.locate(ref);
    const what = this.describe(ref);
    await this.robust(locator, ref, (l) =>
      options.double ? l.dblclick({ timeout: 4_000 }) : l.click({ timeout: 4_000 }),
    );
    return `${options.double ? "Double-clicked" : "Clicked"} ${what}.`;
  }

  async check(ref: string, checked: boolean): Promise<string> {
    const locator = await this.locate(ref);
    const what = this.describe(ref);
    const now = await locator.isChecked().catch(() => undefined);
    if (now === checked) return `${what} was already ${checked ? "checked" : "unchecked"}.`;
    // Many checkboxes hide their input behind a styled box; give up on the input soon and use
    // its label, which takes the click.
    await this.robust(locator, ref, (l, first) =>
      l.setChecked(checked, { timeout: first ? 1_500 : 4_000 }),
    );
    return `${checked ? "Checked" : "Unchecked"} ${what}.`;
  }

  async type(ref: string, text: string, options: { submit?: boolean } = {}): Promise<string> {
    const locator = await this.locate(ref);
    const what = this.describe(ref);
    await this.robust(locator, ref, async (l) => {
      await l.fill(text, { timeout: 4_000 });
      if (options.submit) await l.press("Enter");
    });
    return `Typed into ${what}${options.submit ? " and pressed Enter" : ""}.`;
  }

  async select(ref: string, option: string): Promise<string> {
    const locator = await this.locate(ref);
    const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
    if (tag !== "select") {
      throw new ActionError(
        `${this.describe(ref)} is not a native dropdown. Click it to open it, then click the option's ref.`,
      );
    }
    const chosen = await locator
      .selectOption({ label: option }, { timeout: 4_000 })
      .catch(() => locator.selectOption(option, { timeout: 4_000 }));
    if (!chosen.length) throw new ActionError(`No option "${option}" in ${this.describe(ref)}.`);
    return `Selected "${option}" in ${this.describe(ref)}.`;
  }

  async press(key: string, ref?: string): Promise<string> {
    if (ref) await (await this.locate(ref)).press(key, { timeout: 4_000 });
    else await this.current.keyboard.press(key);
    return `Pressed ${key}${ref ? ` in ${this.describe(ref)}` : ""}.`;
  }

  async scroll(direction: "up" | "down", ref?: string): Promise<string> {
    if (ref) {
      await (await this.locate(ref)).scrollIntoViewIfNeeded({ timeout: 4_000 });
      return `Scrolled ${this.describe(ref)} into view.`;
    }
    const before = await this.current.evaluate(() => window.scrollY);
    const height = this.current.viewportSize()?.height ?? 900;
    await this.current.mouse.wheel(0, direction === "down" ? height * 0.8 : -height * 0.8);
    await sleep(300);
    const after = await this.current.evaluate(() => window.scrollY);
    return after === before
      ? `Could not scroll ${direction}; the page is at its ${direction === "down" ? "end" : "top"}.`
      : `Scrolled ${direction}.`;
  }

  private learnParams(href: string, base?: string): void {
    try {
      const url = new URL(href, base);
      const seen = this.seenParams.get(url.host) ?? new Set<string>();
      for (const key of url.searchParams.keys()) seen.add(key);
      this.seenParams.set(url.host, seen);
    } catch {
      // not a URL
    }
  }

  async navigate(target: string): Promise<string> {
    let guessed: string[] = [];
    if (target === "back") await this.current.goBack({ timeout: 15_000 });
    else if (target === "forward") await this.current.goForward({ timeout: 15_000 });
    else if (target === "reload") await this.current.reload({ timeout: 15_000 });
    else {
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `https://${target}`);
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new ActionError(`Only http and https URLs are allowed.`);
      if (this.options.blockPrivateNetwork && isPrivateHost(url.hostname))
        throw new ActionError(
          `${url.hostname} is on a local or private network, which this browser may not reach.`,
        );
      const seen = this.seenParams.get(url.host);
      guessed = [...new Set(url.searchParams.keys())].filter((key) => !seen?.has(key));
      await this.current
        .goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch((error: unknown) => {
          throw new ActionError(`Could not open ${url.href}: ${firstLine(error)}`);
        });
    }
    this.learnParams(this.current.url());
    const warning = guessed.length
      ? ` Note: this site has not shown the parameter${guessed.length > 1 ? "s" : ""} ${guessed.join(", ")} yet, so ${guessed.length > 1 ? "they were" : "it was"} guessed and may be ignored. Check that the page reflects ${guessed.length > 1 ? "them" : "it"}, or use the site's own search box and filters.`
      : "";
    return `Opened ${this.current.url()}.${warning}`;
  }

  async tabs(action: "list" | "switch" | "close", index?: number): Promise<string> {
    const pages = this.context.pages();
    if (action !== "list") {
      const page = pages[(index ?? 0) - 1];
      if (!page) throw new ActionError(`No tab ${index}; there are ${pages.length}.`);
      if (action === "switch") {
        this.setCurrent(page);
        await page.bringToFront();
      } else await page.close();
    }
    const list = await Promise.all(
      this.context
        .pages()
        .map(
          async (p, i) =>
            `${i + 1}. ${await p.title().catch(() => "")} — ${p.url()}${p === this.current ? " (current)" : ""}`,
        ),
    );
    return list.join("\n");
  }

  /** Run an action; when the page swallows it, fall back the way a person would or explain what is in the way. */
  private async robust(
    locator: Locator,
    ref: string,
    /** `first` is the element itself; a retry goes to its label. */
    act: (l: Locator, first: boolean) => Promise<unknown>,
  ): Promise<void> {
    try {
      await act(locator, true);
      return;
    } catch (error) {
      const message = String(error);
      if (/intercepts pointer events|outside of the viewport|not visible/.test(message)) {
        const label = await labelFor(locator);
        if (label) {
          try {
            await act(label === "self" ? locator : label, false);
            return;
          } catch {
            // fall through to the explanation below
          }
        }
        const blocker =
          /<[^>]*?(?:role="dialog"|aria-modal|class="[^"]*(?:modal|overlay|consent|cookie)[^"]*")[^>]*>/i.exec(
            message,
          );
        if (blocker || /intercepts pointer events/.test(message)) {
          throw new ActionError(
            `Could not reach ${this.describe(ref)}: something covers it${blocker ? ` (${blocker[0].slice(0, 160)})` : ""}. Close or answer the dialog listed under OPEN DIALOGS first, or press Escape.`,
          );
        }
        throw new ActionError(
          `${this.describe(ref)} is not visible. Scroll to it or open the section that contains it.`,
        );
      }
      if (/Timeout/.test(message))
        throw new ActionError(
          `${this.describe(ref)} did not respond in time. Observe and try another way.`,
        );
      throw new ActionError(firstLine(error));
    }
  }
}

const USERNAME_FIELDS = [
  'input[autocomplete~="username"]',
  "input[type=email]",
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[name*="brukernavn" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
]
  .map((selector) => `${selector}:visible`)
  .join(", ");

/** Runs in a frame: the visible login fields' values. A string, so it compiles without the DOM lib. */
const LOGIN_FIELDS = `(() => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const password = [...document.querySelectorAll("input[type=password]")].find(visible);
  const scope = (password && password.form) || document;
  const selectors = ${JSON.stringify(USERNAME_FIELDS.replaceAll(":visible", ""))};
  const user = [...scope.querySelectorAll(selectors)].find(visible)
    || (password ? [...scope.querySelectorAll("input[type=text]")].find(visible) : undefined);
  return { host: location.hostname, username: user ? user.value : "", password: password ? password.value : "" };
})()`;

/** Replaces saved credential values anywhere in a snapshot. */
function scrub(raw: string, values: ReadonlySet<string>): string {
  let out = raw;
  for (const value of values) if (value.length >= 3) out = out.split(value).join("[hidden]");
  return out;
}

const SECRET_FIELDS = [
  "input[type=password]",
  'input[autocomplete~="one-time-code"]',
  'input[autocomplete~="current-password"]',
  'input[autocomplete~="new-password"]',
  'input[autocomplete~="cc-number"]',
  'input[autocomplete~="cc-csc"]',
].join(",");

/**
 * The accessibility snapshot shows what fields hold, passwords included. Values of secret fields
 * become `[hidden]` on textbox lines, whatever their length.
 */
export function hideSecrets(raw: string, secrets: readonly string[]): string {
  if (!secrets.length) return raw;
  const hidden = new Set(secrets.flatMap((value) => [value, JSON.stringify(value)]));
  return raw
    .split("\n")
    .map((line) => {
      const match = /^(\s*- (?:textbox|searchbox|combobox|spinbutton)\b[^:]*?): (.*)$/.exec(line);
      return match && hidden.has(match[2]!) ? `${match[1]}: [hidden]` : line;
    })
    .join("\n");
}

/** A visually hidden checkbox or radio is usually operated through its label. */
async function labelFor(locator: Locator): Promise<Locator | "self" | undefined> {
  const id = await locator
    .evaluate((el) => {
      const input = el as unknown as PageInput;
      if (!input.labels?.length) return undefined;
      const label = input.labels[0]!;
      if (!label.id) label.id = `nudge-label-${Math.random().toString(36).slice(2)}`;
      return label.id;
    })
    .catch(() => undefined);
  if (!id) return undefined;
  return locator.page().locator(`[id="${id}"]`);
}

async function startXvfb(viewport?: {
  width: number;
  height: number;
}): Promise<{ display: string; process: ChildProcess }> {
  const size = viewport ?? { width: 1280, height: 900 };
  for (let n = 90; n < 140; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    const display = `:${n}`;
    const child = spawn(
      "Xvfb",
      [display, "-screen", "0", `${size.width}x${size.height}x24`, "-nolisten", "tcp"],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${n}`); i++) {
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    if (existsSync(`/tmp/.X11-unix/X${n}`)) {
      process.once("exit", () => child.kill());
      return { display, process: child };
    }
    child.kill();
  }
  throw new Error("Could not start Xvfb. Install xvfb, or run headless.");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Hosts on this machine or the local network, by name or address literal. Names that resolve to
 * private addresses are not caught here.
 */
export function isPrivateHost(host: string): boolean {
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!name) return false;
  if (name === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(name))
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (name.includes(":")) {
    if (name === "::1" || name === "::") return true;
    if (/^(fc|fd)/.test(name) || /^fe[89ab]/.test(name)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(name);
    return mapped ? isPrivateHost(mapped[1]!) : false;
  }
  return false;
}

function firstLine(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .split("\n")[0]!
    .slice(0, 300);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
