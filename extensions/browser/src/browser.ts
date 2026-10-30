import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Locator, type Page, type Request } from "patchright";
import { type ActionTarget, inspectTarget, siteOf } from "./gate.ts";
import type { SavedLogin } from "./logins.ts";
import { compactSnapshot, findLines } from "./snapshot.ts";
import {
  callInPage,
  listInPage,
  PAGE_TOOL_RESULT_CHARS,
  PAGE_TOOL_TIMEOUT_MS,
  type PageTool,
  WEBMCP_INIT,
} from "./webmcp.ts";

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
  /**
   * Record the tools pages offer through WebMCP (`modelContext.registerTool`), standing in for the
   * API where the browser has none, so the agent can call them. On by default.
   */
  webmcp?: boolean;
  /** Extra Chromium command-line arguments, such as `--enable-features=…` for WebMCP. */
  args?: readonly string[];
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
  /** Sites logged in on in this session, with browser_login or in the live view (`siteOf`). */
  private loggedInSites = new Set<string>();
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
    // Said before the download, which is no use without a display; the assistant tells the room.
    const problem = headless ? undefined : displayProblem();
    if (problem !== undefined) throw new Error(problem);
    await ensureChromium();
    const xvfb = !headless && !process.env.DISPLAY ? await startXvfb(options.viewport) : undefined;
    const viewport = options.viewport ?? { width: 1280, height: 900 };
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless,
      viewport,
      locale: options.locale ?? "nb-NO",
      ...(xvfb ? { env: { ...process.env, DISPLAY: xvfb.display } } : {}),
      ...(options.args === undefined || options.args.length === 0
        ? {}
        : { args: [...options.args] }),
    });
    // Before any page's scripts, so it sees every tool they register.
    if (options.webmcp !== false) await context.addInitScript(WEBMCP_INIT);
    if (options.blockPrivateNetwork)
      await context.route("**/*", async (route) =>
        (await reachesPrivate(hostOf(route.request().url())))
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
    const tools = await this.pageTools().catch(() => []);
    const header = [
      `URL: ${this.current.url()}`,
      `Title: ${await this.current.title().catch(() => "")}`,
      tabs.length > 1
        ? `Tabs: ${tabs.length} (current is ${tabs.indexOf(this.current) + 1})`
        : undefined,
      tools.length > 0
        ? `Page tools (WebMCP): ${tools.map((tool) => tool.name).join(", ")}; see browser_page_tools`
        : undefined,
    ].filter(Boolean);
    return [...header, "", snapshot.text].join("\n");
  }

  /** The host of the current page, such as `www.example.no`; empty when it has none. */
  pageHost(): string {
    try {
      return new URL(this.current.url()).hostname;
    } catch {
      return "";
    }
  }

  /** The tools the current page registered through WebMCP; none when that is off. */
  async pageTools(): Promise<PageTool[]> {
    if (this.options.webmcp === false) return [];
    // In the page's own world, where its scripts registered them.
    return (await this.current.evaluate(listInPage, undefined, undefined, false)) ?? [];
  }

  /** Calls one of the current page's WebMCP tools with `input`, and gives its result as text. */
  async callPageTool(name: string, input: unknown): Promise<string> {
    if (this.options.webmcp === false)
      throw new ActionError("Page tools are turned off in the browser's settings.");
    const outcome = await this.current.evaluate(
      callInPage,
      { name, input, timeoutMs: PAGE_TOOL_TIMEOUT_MS },
      undefined,
      false,
    );
    if ("error" in outcome)
      throw new ActionError(`The page's tool "${name}" failed: ${outcome.error}`);
    const text = scrub(outcome.text, this.scrubbed);
    return text.length > PAGE_TOOL_RESULT_CHARS
      ? `${text.slice(0, PAGE_TOOL_RESULT_CHARS)}\n(cut: the result was ${text.length} characters)`
      : text;
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
      // Saved or not, someone logged in there.
      this.loggedInSites.add(siteOf(login.host));
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
        this.loggedInSites.add(siteOf(host));
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

  /**
   * What an action is about to touch, for `needsApproval`: the element by ref, or without one the
   * element that has the keyboard, in whichever frame; undefined when nothing does.
   */
  async inspect(ref?: string): Promise<ActionTarget | undefined> {
    const read = async (locator: Locator) => {
      const target =
        (await locator.evaluate(inspectTarget, undefined, { timeout: 4_000 })) ?? undefined;
      if (target && !target.loggedIn) target.loggedIn = this.loggedInOn(target.host);
      return target;
    };
    if (ref !== undefined) {
      const locator = await this.locate(ref);
      try {
        return await read(locator);
      } catch (error) {
        // Not knowing what it is must not let it through.
        throw new ActionError(
          `Could not check ${this.describe(ref)} before acting (${String(error).split("\n")[0]}). Observe again and retry.`,
        );
      }
    }
    // The innermost frame with a focused element: a focused iframe hands it to its own page.
    let found: ActionTarget | undefined;
    for (const frame of this.current.frames()) {
      const focused = frame.locator(":focus").first();
      if ((await focused.count().catch(() => 0)) === 0) continue;
      const target = await read(focused).catch(() => undefined);
      if (target && target.tag !== "iframe" && target.tag !== "frame") found = target;
    }
    return found;
  }

  /**
   * Whether the user is logged in on a host's site as far as this session knows: browser_login
   * or someone in the live view logged in there, or a login is saved for the host. A page without
   * a log-out control in sight can still be logged in.
   */
  loggedInOn(host: string): boolean {
    if (!host) return false;
    return this.loggedInSites.has(siteOf(host)) || this.findLogin(host) !== undefined;
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
      if (this.options.blockPrivateNetwork && (await reachesPrivate(url.hostname)))
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

let installing: Promise<void> | undefined;

/**
 * Chromium, downloaded the first time it is needed, into `~/.cache/ms-playwright`, or
 * `PLAYWRIGHT_BROWSERS_PATH`: the build a server's release names, else as `patchright install
 * chromium` does. A server's release carries the extension but not the browser, which is large;
 * the system libraries it needs come with the server's image.
 */
export function ensureChromium(): Promise<void> {
  if (existsSync(chromium.executablePath())) return Promise.resolve();
  installing ??= (async () => {
    // Google's storage, where patchright gets it, is slow from some hosts: from exe.dev it would
    // take hours. The release's own copy comes from GitHub.
    let fromRelease: string | undefined;
    try {
      const pointer = join(dirname(process.execPath), "..", "..", "chromium.json");
      if (existsSync(pointer)) await chromiumFrom(pointer);
      if (existsSync(chromium.executablePath())) return;
    } catch (error) {
      fromRelease = (error as Error).message;
    }
    const cli = join(
      dirname(createRequire(import.meta.url).resolve("patchright/package.json")),
      "cli.js",
    );
    try {
      await promisify(execFile)(process.execPath, [cli, "install", "chromium"], {
        timeout: 10 * 60_000,
        maxBuffer: 16 << 20,
      });
    } catch (error) {
      // The cause is an `Error:` line, such as a refused connection, beside two that only say it
      // failed.
      const { message, stdout = "" } = error as Error & { stdout?: string };
      const lines = `${stdout}\n${message}`.split("\n").map((line) => line.trim());
      const why =
        lines
          .find(
            (line) =>
              line.startsWith("Error: ") &&
              !/^Error: (Failed to download|Download failure)/.test(line),
          )
          ?.slice(7) ??
        lines.findLast((line) => line.length > 1) ??
        "";
      throw new Error(
        `Could not download Chromium: ${fromRelease === undefined ? why : `${fromRelease}; then ${why}`}`,
      );
    }
  })().finally(() => {
    installing = undefined;
  });
  return installing;
}

/**
 * Unpacks the Chromium the release names in `pointer` (`{ url, sha256 }`, as patchright lays out
 * its browsers) where patchright looks for it, once the download has that sha256.
 */
async function chromiumFrom(pointer: string): Promise<void> {
  const { url, sha256 } = JSON.parse(await readFile(pointer, "utf8")) as {
    url: string;
    sha256: string;
  };
  // Such as ~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome.
  let browser = chromium.executablePath();
  while (!/^chromium-\d+$/.test(basename(browser)) && dirname(browser) !== browser)
    browser = dirname(browser);
  const browsers = dirname(browser);
  const unpacking = join(browsers, `.unpacking-${process.pid}`);
  await rm(unpacking, { recursive: true, force: true });
  await mkdir(unpacking, { recursive: true });
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || response.body === null)
      throw new Error(`The release's Chromium answered ${response.status}`);
    const archive = join(unpacking, "chromium.tar.gz");
    const hash = createHash("sha256");
    const file = await open(archive, "w");
    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
    if (hash.digest("hex") !== sha256)
      throw new Error("The release's Chromium isn't the one the release names");
    await promisify(execFile)("tar", ["-xzf", archive, "-C", unpacking]);
    await rm(archive);
    for (const name of await readdir(unpacking)) {
      await rm(join(browsers, name), { recursive: true, force: true });
      await rename(join(unpacking, name), join(browsers, name));
    }
  } finally {
    await rm(unpacking, { recursive: true, force: true });
  }
}

/**
 * Why the browser can't run headed here, if it can't: it needs a display, its own virtual one
 * (`Xvfb`) when there is none. A server made from an image without it can only run headless.
 */
export function displayProblem(): string | undefined {
  if (process.env.DISPLAY) return undefined;
  const found = (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, "Xvfb")));
  return found
    ? undefined
    : "This server has no virtual display (Xvfb) for the browser. A server made from an older Nudge image lacks it and Chromium's libraries: make a new server for the browser.";
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

/** How long what a name resolves to is kept, so a page's many requests ask DNS once. */
const RESOLVED_MS = 60_000;
const resolved = new Map<string, { at: number; private: Promise<boolean> }>();

/**
 * Whether a host is on this machine or the local network: by its name, or by any address it
 * resolves to, so a public-looking name that points at 127.0.0.1 or the LAN is caught too. Chromium
 * resolves the name again for itself, so a DNS answer that changes in between (rebinding) is a
 * narrow gap left open. A name that doesn't resolve is left to Chromium, which fails on it too.
 */
export function reachesPrivate(host: string): Promise<boolean> {
  if (!host) return Promise.resolve(false);
  if (isPrivateHost(host)) return Promise.resolve(true);
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  const now = Date.now();
  const known = resolved.get(name);
  if (known && now - known.at < RESOLVED_MS) return known.private;
  const answer = lookup(name, { all: true, verbatim: true }).then(
    (addresses) => addresses.some(({ address }) => isPrivateHost(address)),
    () => false,
  );
  if (resolved.size > 1_000) resolved.clear();
  resolved.set(name, { at: now, private: answer });
  return answer;
}

/**
 * Hosts on this machine or the local network, by name or address literal. Names that resolve to
 * private addresses are caught by `reachesPrivate`.
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
