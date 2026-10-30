// Drives a real browser over fixture pages shaped like the sites that tripped the agent up: run
// with NUDGE_BROWSER_TESTS=1 (needs patchright's Chromium).
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, BrowserSession } from "../src/browser.ts";
import { type Approval, needsApproval } from "../src/gate.ts";
import { runBatch } from "../src/tools.ts";

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang=nb><head><title>${title}</title><style>${head}</style></head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  // A shop that offers agents its own tools (WebMCP): a search that only reads, an add to the
  // basket that changes it, one through the older navigator.modelContext, and one more after a click.
  "/webmcp": page(
    "Butikk",
    `<h1>Butikk</h1><p id=basket>Tom kurv</p><button id=more>Vis flere verktøy</button>
    <script>
      const basket = [];
      document.modelContext.registerTool({
        name: "search",
        description: "Search the shop's products",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        annotations: { readOnlyHint: true },
        execute: async ({ query }) => ({ content: [{ type: "text", text: "Found: " + query + " (2 for 39 kr)" }] }),
      });
      document.modelContext.registerTool({
        name: "add_to_basket",
        description: "Put a product in the basket",
        inputSchema: { type: "object", properties: { product: { type: "string" } } },
        execute: ({ product }) => {
          basket.push(product);
          document.getElementById("basket").textContent = basket.join(", ");
          return "In the basket: " + basket.join(", ");
        },
      });
      navigator.modelContext.registerTool({
        name: "slow",
        description: "Never answers",
        annotations: { readOnlyHint: true },
        execute: () => new Promise(() => {}),
      });
      document.getElementById("more").onclick = () =>
        document.modelContext.registerTool({
          name: "opening_hours", description: "When the shop is open", annotations: { readOnlyHint: true },
          execute: () => "09–21",
        });
    </script>`,
  ),
  // A consent dialog added last, after the page, as many consent scripts do; it covers the page.
  "/dialog": page(
    "Nyheter",
    `<h1>Nyheter</h1><p>Dagens saker.</p><button onclick="document.title='Lest'">Les mer</button>
    <div class=overlay><div role=dialog aria-modal=true aria-label="Informasjonskapsler">
      <p>Vi bruker informasjonskapsler.</p>
      <button onclick="this.closest('.overlay').remove()">Godta alle</button>
      <button onclick="this.closest('.overlay').remove()">Bare nødvendige</button>
    </div></div>`,
    `.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: grid; place-items: center }
    [role=dialog] { background: white; padding: 2em }`,
  ),
  // Checkboxes whose real input is hidden behind a styled box: clicking the input itself fails.
  "/filters": page(
    "Filter",
    `<h1>Filter</h1>
    <label class=box><input type=checkbox name=elbil><span>Elbil</span></label>
    <input type=checkbox id=hybrid class=sr-only><label for=hybrid class=box><span>Hybrid</span></label>
    <p id=state></p>
    <script>
      for (const input of document.querySelectorAll("input"))
        input.addEventListener("change", () => (document.getElementById("state").textContent =
          [...document.querySelectorAll("input:checked")].map((i) => i.name || i.id).join(",")));
    </script>`,
    `label.box { position: relative; display: block; padding: 8px 8px 8px 36px }
    label.box::before { content: ""; position: absolute; left: 4px; top: 4px; width: 24px; height: 24px; border: 2px solid; z-index: 1 }
    label.box input { position: absolute; left: 6px; top: 6px; opacity: 0; margin: 0 }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); margin: -1px }`,
  ),
  // A carousel: a scrolling row of listings, most out of view, and a dot per slide.
  "/carousel": page(
    "Ferier",
    `<h1>Populære reisemål</h1>
    <ul class=track>${[1, 2, 3, 4, 5, 6]
      .map(
        (n) =>
          `<li><a href="/trip/${n}"><h3>Reise ${n}</h3><p>${n} 000 kr</p><p>${n + 2} netter</p></a></li>`,
      )
      .join("")}</ul>
    <div>${[1, 2, 3, 4, 5, 6].map((n) => `<button aria-label="Gå til lysbilde ${n}"></button>`).join("")}</div>`,
    `.track { display: flex; width: 400px; overflow: hidden; list-style: none; padding: 0 }
    .track li { flex: 0 0 200px }`,
  ),
  // A list a click renders anew: refs taken before the click point at elements that are gone.
  "/stale": page(
    "Treff",
    `<h1>Treff</h1><button id=sort>Sorter etter pris</button><ul id=hits></ul>
    <script>
      const render = (names) => (document.getElementById("hits").innerHTML =
        names.map((name) => '<li><a href="/hit/' + name + '">' + name + "</a></li>").join(""));
      render(["Oslo", "Bergen", "Trondheim"]);
      document.getElementById("sort").onclick = () => render(["Bergen", "Oslo", "Trondheim"]);
    </script>`,
  ),
  // Cards that are buttons holding a heading and details, each with a small button of its own.
  "/cabins": page(
    "Hytter",
    `<h1>Hytter</h1><ul>${["Hemsedal", "Geilo", "Trysil"]
      .map(
        (place) =>
          `<li><button class=card onclick="location.href='/cabin/${place}'"><h3>Hytte i ${place}</h3><p>4 soverom</p><p>2 500 kr natt</p></button><button aria-label="Lagre ${place}">♥</button></li>`,
      )
      .join("")}</ul>`,
  ),
  // A checkout on a site the user is logged in to: what commits them, next to what doesn't.
  "/checkout": page(
    "Kasse",
    `<h1>Kasse</h1><nav><a href="/konto/logg-ut">Logg ut</a></nav>
    <form method=get action=/sok><input name=q aria-label="Søk i butikken"><button>Søk</button></form>
    <a href="/kort/1">Kjøp billetter</a> <a href="/vilkar">Kjøpsvilkår</a>
    <form method=post action=/betal>
      <label>Kortnummer <input name=kort autocomplete=cc-number></label>
      <label>Navn på kortet <input name=navn autocomplete=cc-name></label>
      <button><span>Betal 349 kr</span></button>
    </form>
    <div role=textbox contenteditable=true aria-label="Melding til butikken"></div>`,
  ),
  // A shop whose basket leads to a Pay button, with no way to log out in sight.
  "/butikk": page(
    "Butikk",
    `<h1>Kinobilletter</h1><p>2 billetter, 498 kr</p><a href="/kurv">Gå til handlekurven</a>`,
  ),
  "/kurv": page(
    "Handlekurv",
    `<h1>Handlekurv</h1><p>2 billetter, 498 kr</p>
    <form method=post action=/betalt>
      <button>Betal 498 kr</button>
      <button formaction=/slettet>Slett kortet mitt</button>
    </form>`,
  ),
  // A login form, and a profile form that commits nothing by its words.
  "/logg-inn": page(
    "Logg inn",
    `<form method=post action=/innlogget>
      <label>E-post <input name=user autocomplete=username></label>
      <label>Passord <input type=password name=password></label>
      <button>Logg inn</button>
    </form>`,
  ),
  "/profil": page(
    "Profil",
    `<h1>Profil</h1><form method=post action=/lagret>
      <label>Visningsnavn <input name=name></label><button>Lagre</button>
    </form>`,
  ),
};

/** Paths the fixture server got a POST for, like `/betalt`. */
const posted: string[] = [];

function fixture(): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "POST") {
      posted.push(path);
      req.resume();
      res.writeHead(303, { location: path === "/innlogget" ? "/profil" : `/done${path}` });
      return res.end();
    }
    const known = PAGES[path];
    const title = decodeURIComponent(path.split("/").at(-1) ?? "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(known ?? page(title, `<h1>${title}</h1>`));
  });
}

/** The ref on the observation's first line containing `text`. */
function refOf(observation: string, text: string): string {
  const line = observation.split("\n").find((l) => l.includes(text));
  const ref = line && /\[((?:f\d+)?e\d+)\]/.exec(line)?.[1];
  if (!ref) throw new Error(`No ref for "${text}" in:\n${observation}`);
  return ref;
}

const run = process.env.NUDGE_BROWSER_TESTS === "1" ? describe : describe.skip;

run("fixture pages in a real browser", () => {
  let server: Server;
  let session: BrowserSession;
  let base: string;
  beforeAll(async () => {
    server = fixture();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    session = await BrowserSession.open({
      profileDir: mkdtempSync(join(tmpdir(), "nudge-fixtures-")),
      headless: true,
    });
  }, 30_000);
  afterAll(async () => {
    await session?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const open = async (path: string) => {
    await session.navigate(`${base}${path}`);
    await session.settle();
    return session.observe();
  };

  it("shows a dialog at the end of the page first, and says it covers the page", async () => {
    const seen = await open("/dialog");
    const dialogs = seen.indexOf("OPEN DIALOGS");
    expect(dialogs).toBeGreaterThan(-1);
    expect(seen.indexOf('dialog "Informasjonskapsler"')).toBeGreaterThan(dialogs);
    expect(seen.indexOf("PAGE (behind the dialogs)")).toBeLessThan(seen.indexOf("Les mer"));
    // The page's own button can't be reached while the dialog is up.
    const covered = await session.click(refOf(seen, "Les mer")).catch((error: unknown) => error);
    expect(covered).toBeInstanceOf(ActionError);
    expect((covered as Error).message).toMatch(/something covers it/);
    await session.click(refOf(seen, "Bare nødvendige"));
    await session.settle();
    const after = await session.observe();
    expect(after).not.toContain("OPEN DIALOGS");
    await session.click(refOf(after, "Les mer"));
    expect(await session.page.title()).toBe("Lest");
  }, 30_000);

  it("checks checkboxes whose input hides behind a styled box", async () => {
    const seen = await open("/filters");
    expect(seen).toMatch(/checkbox "Elbil" \[(?:f\d+)?e\d+\]/);
    expect(seen).toMatch(/checkbox "Hybrid" \[(?:f\d+)?e\d+\]/);
    expect(await session.check(refOf(seen, '"Elbil"'), true)).toMatch(/^Checked checkbox "Elbil"/);
    expect(await session.check(refOf(seen, '"Hybrid"'), true)).toMatch(
      /^Checked checkbox "Hybrid"/,
    );
    await session.settle();
    const after = await session.observe();
    expect(after).toMatch(/checkbox "Elbil" \[checked\]/);
    expect(after).toMatch(/checkbox "Hybrid" \[checked\]/);
    expect(await session.page.locator("#state").textContent()).toBe("elbil,hybrid");
    expect(await session.check(refOf(after, '"Elbil"'), true)).toMatch(/already checked/);
  }, 30_000);

  it("lists a carousel's slides one per line, out of view too, and folds its dots", async () => {
    const seen = await open("/carousel");
    for (const n of [1, 2, 3, 4, 5, 6])
      expect(seen).toMatch(
        new RegExp(
          `item: Reise ${n} · ${n} 000 kr · ${n + 2} netter \\[(?:f\\d+)?e\\d+\\] → /trip/${n}`,
        ),
      );
    expect(seen).toContain('button "Gå til lysbilde 1"');
    expect(seen).toMatch(/… 5 more like this/);
    // A slide out of view still opens.
    await session.click(refOf(seen, "item: Reise 6"));
    await session.settle();
    expect(session.page.url()).toBe(`${base}/trip/6`);
  }, 30_000);

  it("refuses a ref from before the page changed, and says to look again", async () => {
    const seen = await open("/stale");
    const oslo = refOf(seen, "Oslo");
    await session.click(refOf(seen, "Sorter etter pris"));
    await session.settle();
    const stale = await session.click(oslo).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(ActionError);
    expect((stale as Error).message).toMatch(/no longer on the page.*Observe again/);
    // A fresh look gives refs that work.
    const fresh = await session.observe();
    await session.click(refOf(fresh, "Oslo"));
    await session.settle();
    expect(session.page.url()).toBe(`${base}/hit/Oslo`);
  }, 30_000);

  it("takes a card button as its item, not the small button beside it", async () => {
    const seen = await open("/cabins");
    const line = seen.split("\n").find((l) => l.includes("Hytte i Geilo"));
    expect(line).toMatch(/item: Hytte i Geilo · 4 soverom · 2 500 kr natt \[(?:f\d+)?e\d+\]$/);
    expect(line).not.toContain("Lagre");
    await session.click(refOf(seen, "Hytte i Geilo"));
    await session.settle();
    expect(session.page.url()).toBe(`${base}/cabin/Geilo`);
  }, 30_000);

  it("reads what an action touches, and holds the ones that commit the user", async () => {
    const seen = await open("/checkout");
    const read = async (text: string) => (await session.inspect(refOf(seen, text)))!;
    const pay = await read("Betal 349 kr");
    expect(pay).toMatchObject({
      tag: "button",
      name: "Betal 349 kr",
      submits: true,
      form: { method: "post", hasPassword: false },
      loggedIn: true,
    });
    expect(needsApproval({ kind: "click" }, pay)).toMatch(/"Betal 349 kr" commits the user/);
    expect(needsApproval({ kind: "type", submit: false }, await read("Kortnummer"))).toMatch(
      /card number/,
    );
    // Its name field is in the same form: Enter in it would pay too.
    expect(needsApproval({ kind: "press", key: "Enter" }, await read("Navn på kortet"))).toMatch(
      /logged in/,
    );
    expect(needsApproval({ kind: "type", submit: true }, await read("Søk i butikken"))).toBe(
      undefined,
    );
    expect(await read("Kjøp billetter")).toMatchObject({ tag: "a", navigates: true });
    expect(needsApproval({ kind: "click" }, await read("Kjøp billetter"))).toBe(undefined);

    // Through the tools: refused, and the page stays where it was.
    const [refused] = await runBatch(session, [
      { id: "a", name: "browser_click", arguments: { ref: refOf(seen, "Betal 349 kr") } },
    ]);
    expect(refused!.text).toMatch(/^Not done: .*browser_confirm/);
    expect(session.page.url()).toBe(`${base}/checkout`);
    // Enter in the focused message box, with no ref, would send it.
    await session.click(refOf(seen, "Melding til butikken"));
    const [enter] = await runBatch(session, [
      { id: "b", name: "browser_press", arguments: { key: "Enter" } },
    ]);
    expect(enter!.text).toMatch(/^Not done: Enter here may send/);
  }, 30_000);

  it("can't press Pay at the end of a shop without approval, and an approval is for that button only", async () => {
    posted.length = 0;
    const shop = await open("/butikk");
    // Following the shop to its basket is plain browsing.
    const [toBasket] = await runBatch(session, [
      { id: "a", name: "browser_click", arguments: { ref: refOf(shop, "Gå til handlekurven") } },
    ]);
    expect(toBasket!.isError).toBe(false);
    expect(session.page.url()).toBe(`${base}/kurv`);
    const basket = await session.observe();
    const pay = refOf(basket, "Betal 498 kr");
    const [refused] = await runBatch(session, [
      { id: "b", name: "browser_click", arguments: { ref: pay } },
    ]);
    expect(refused!.text).toMatch(/^Not done: "Betal 498 kr" commits the user.*browser_confirm/);
    expect(posted).toEqual([]);

    // The model asks; what it asks for is pinned to that button on this site.
    const approval: Approval = {};
    const [asked] = await runBatch(
      session,
      [
        {
          id: "c",
          name: "browser_confirm",
          arguments: { action: "Pay 498 kr for 2 tickets", tool: "browser_click", ref: pay },
        },
      ],
      undefined,
      approval,
    );
    expect(asked).toMatchObject({ ends: "needs-confirmation" });
    expect(approval.asked).toEqual({
      tool: "browser_click",
      host: "127.0.0.1",
      element: 'button[submit] "Betal 498 kr"',
    });

    // Approved and started again: another button that commits the user still needs its own.
    const approved: Approval = { approved: approval.asked! };
    const again = await session.observe();
    const [other] = await runBatch(
      session,
      [{ id: "d", name: "browser_click", arguments: { ref: refOf(again, "Slett kortet mitt") } }],
      undefined,
      approved,
    );
    expect(other!.text).toMatch(/^Not done: .*approved a different action/);
    expect(posted).toEqual([]);
    const [paid] = await runBatch(
      session,
      [{ id: "e", name: "browser_click", arguments: { ref: refOf(again, "Betal 498 kr") } }],
      undefined,
      approved,
    );
    expect(paid!.isError).toBe(false);
    expect(posted).toEqual(["/betalt"]);
    expect(approved.approved).toBeUndefined();
  }, 30_000);

  it("lists a page's WebMCP tools, calls the read-only ones, and holds the rest for approval", async () => {
    const seen = await open("/webmcp");
    expect(seen).toContain(
      "Page tools (WebMCP): search, add_to_basket, slow; see browser_page_tools",
    );
    const [listed] = await runBatch(session, [
      { id: "a", name: "browser_page_tools", arguments: {} },
    ]);
    expect(listed!.text).toContain("- search (reads): Search the shop's products");
    expect(listed!.text).toContain("- add_to_basket (may change things");

    const [found] = await runBatch(session, [
      {
        id: "b",
        name: "browser_call_page_tool",
        arguments: { name: "search", arguments: { query: "melk" } },
      },
    ]);
    expect(found!.isError).toBe(false);
    expect(found!.text.split("\n")[0]).toBe("Found: melk (2 for 39 kr)");

    const approval: Approval = {};
    const add = { name: "add_to_basket", arguments: { product: "melk" } };
    const [held] = await runBatch(
      session,
      [{ id: "c", name: "browser_call_page_tool", arguments: add }],
      undefined,
      approval,
    );
    expect(held!.text).toMatch(/^Not done: the page's tool "add_to_basket" may change things/);
    expect(await session.page.textContent("#basket")).toBe("Tom kurv");

    await runBatch(
      session,
      [
        {
          id: "d",
          name: "browser_confirm",
          arguments: {
            action: "Add milk",
            tool: "browser_call_page_tool",
            pageTool: add.name,
            arguments: add.arguments,
          },
        },
      ],
      undefined,
      approval,
    );
    expect(approval.asked?.tool).toBe("browser_call_page_tool");
    // Approved for milk only: bread is still held, milk goes through once.
    const approved: Approval = { approved: approval.asked! };
    const [bread] = await runBatch(
      session,
      [
        {
          id: "e",
          name: "browser_call_page_tool",
          arguments: { ...add, arguments: { product: "brød" } },
        },
      ],
      undefined,
      approved,
    );
    expect(bread!.text).toContain("The user approved a different action");
    const [milk] = await runBatch(
      session,
      [{ id: "f", name: "browser_call_page_tool", arguments: add }],
      undefined,
      approved,
    );
    expect(milk!.text.split("\n")[0]).toBe("In the basket: melk");
    expect(approved.approved).toBeUndefined();

    await session.page.click("#more");
    expect((await session.pageTools()).map((tool) => tool.name)).toContain("opening_hours");
  });

  it("counts a site as logged in after browser_login, with no log-out control on the page", async () => {
    const profile = await open("/profil");
    const save = async (seen: string) => (await session.inspect(refOf(seen, "Lagre")))!;
    expect(await save(profile)).toMatchObject({ loggedIn: false, host: "127.0.0.1" });
    expect(needsApproval({ kind: "click" }, await save(profile))).toBeUndefined();

    session.useLogins(
      (host) =>
        host === "127.0.0.1"
          ? { host, username: "kari@example.no", password: "hemmelig", savedAt: 0 }
          : undefined,
      [],
    );
    await open("/logg-inn");
    const [login] = await runBatch(session, [{ id: "a", name: "browser_login", arguments: {} }]);
    expect(login!.text).toMatch(/^Filled in the saved login for 127\.0\.0\.1/);
    expect(session.page.url()).toBe(`${base}/profil`);
    const after = await session.observe();
    expect(await save(after)).toMatchObject({ loggedIn: true });
    expect(needsApproval({ kind: "click" }, await save(after))).toMatch(/logged in/);
    session.useLogins(() => undefined, []);
  }, 30_000);

  it("counts a site as logged in after a login in the live view", async () => {
    const fresh = await BrowserSession.open({
      profileDir: mkdtempSync(join(tmpdir(), "nudge-fixtures-")),
      headless: true,
    });
    try {
      await fresh.navigate(`${base}/logg-inn`);
      // As the person in the live view does it: typing, then Enter, which reads the fields.
      await fresh.page.fill("input[name=user]", "kari@example.no");
      await fresh.page.fill("input[type=password]", "hemmelig");
      await fresh.captureLogin();
      await fresh.page.press("input[type=password]", "Enter");
      await fresh.settle();
      // Not saved; logged in all the same.
      expect(fresh.takeCaptured().map((l) => l.host)).toEqual(["127.0.0.1"]);
      expect(fresh.page.url()).toBe(`${base}/profil`);
      const seen = await fresh.observe();
      const save = (await fresh.inspect(refOf(seen, "Lagre")))!;
      expect(save).toMatchObject({ loggedIn: true });
      expect(fresh.loggedInOn("www.example.no")).toBe(false);
    } finally {
      await fresh.close();
    }
  }, 30_000);
});
