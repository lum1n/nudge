// Drives a real browser: run with NUDGE_BROWSER_TESTS=1 (needs patchright's Chromium).
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, BrowserSession } from "../src/browser.ts";
import { type LiveOutput, startLiveView } from "../src/live.ts";
import { LoginStore } from "../src/logins.ts";

const USER = "ola.nordmann";
const PASSWORD = "Hemmelig-pass-42";

const page = (body: string) =>
  `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

/** A site with a one-step login, a two-step login, and a page that says who is logged in. */
function fixture(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const cookie = req.headers.cookie ?? "";
    const html = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(page(body));
    };
    if (url.pathname === "/login" && req.method === "GET")
      return html(
        200,
        `<h1>Logg inn</h1><form method=post action=/login><label>Brukernavn <input name=username autocomplete=username></label><label>Passord <input type=password name=password></label><button>Logg inn</button></form>`,
      );
    if (url.pathname === "/step1")
      return html(
        200,
        `<h1>Steg 1</h1><form method=get action=/step2><label>Brukernavn <input name=username autocomplete=username></label><button>Neste</button></form>`,
      );
    if (url.pathname === "/step2")
      return html(
        200,
        `<h1>Steg 2</h1><form method=post action=/login><input type=hidden name=username value="${url.searchParams.get("username") ?? ""}"><label>Passord <input type=password name=password></label><button>Logg inn</button></form>`,
      );
    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const ok = form.get("password") === PASSWORD;
        if (ok)
          html(303, "", {
            location: "/home",
            "set-cookie": `session=${form.get("username")}; Path=/`,
          });
        else html(401, "<h1>Feil passord</h1>");
      });
      return;
    }
    if (url.pathname === "/home") {
      const who = /session=([^;]+)/.exec(cookie)?.[1];
      return html(
        200,
        who
          ? `<h1>Velkommen</h1><p>Innlogget som ${decodeURIComponent(who)}</p>`
          : `<h1>Ikke innlogget</h1>`,
      );
    }
    html(404, "<h1>Ikke funnet</h1>");
  });
}

const run = process.env.NUDGE_BROWSER_TESTS === "1" ? describe : describe.skip;

run("logging in: live view first, saved login after", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = fixture();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const base = () => `http://127.0.0.1:${port}`;
  const open = () =>
    BrowserSession.open({
      profileDir: mkdtempSync(join(tmpdir(), "nudge-login-")),
      headless: true,
    });

  /** What the web UI would do: click a field's middle, type, press Enter. */
  async function typeInto(
    live: { receive(data: string): void },
    session: BrowserSession,
    selector: string,
    text: string,
  ) {
    const box = (await session.page.locator(selector).boundingBox())!;
    live.receive(
      JSON.stringify({ type: "click", x: box.x + box.width / 2, y: box.y + box.height / 2 }),
    );
    live.receive(JSON.stringify({ type: "text", text }));
  }

  async function settled(live: { receive(data: string): void }, outputs: LiveOutput[]) {
    const before = outputs.filter((o) => o.type === "done").length;
    live.receive(JSON.stringify({ type: "done", remember: true }));
    for (let i = 0; i < 100 && outputs.filter((o) => o.type === "done").length === before; i++)
      await new Promise((r) => setTimeout(r, 50));
  }

  it("captures a login typed in the live view, saves it, and fills it in later on that host only", async () => {
    const store = new LoginStore(mkdtempSync(join(tmpdir(), "nudge-store-")));
    const first = await open();
    first.useLogins((host) => store.find("room", host), []);
    await first.navigate(`${base()}/login`);
    const outputs: LiveOutput[] = [];
    const live = await startLiveView(
      first,
      (o) => outputs.push(o),
      (remember) => {
        const captured = first.takeCaptured();
        if (remember) for (const login of captured) store.save("room", { ...login, savedAt: 1 });
        return captured.map((l) => l.host);
      },
    );
    await typeInto(live, first, "input[name=username]", USER);
    await typeInto(live, first, "input[name=password]", PASSWORD);
    // While typed but not sent, the model's view hides the password.
    await new Promise((r) => setTimeout(r, 300));
    expect(await first.observe()).not.toContain(PASSWORD);
    live.receive(JSON.stringify({ type: "key", key: "Enter" }));
    await settled(live, outputs);
    expect(outputs.find((o) => o.type === "frame")).toBeDefined();
    expect(outputs.findLast((o) => o.type === "done")).toEqual({
      type: "done",
      saved: ["127.0.0.1"],
    });
    expect(await first.observe()).toContain("Velkommen");
    live.close();
    await first.close();
    expect(store.find("room", "127.0.0.1")).toMatchObject({ username: USER, password: PASSWORD });

    // A fresh browser without the cookie logs in by itself.
    const second = await open();
    const saved = store.list("room").flatMap((l) => [l.username ?? "", l.password]);
    second.useLogins((host) => store.find("room", host), saved);
    await second.navigate(`${base()}/login`);
    const result = await second.login();
    expect(result).toBe("Filled in the saved login for 127.0.0.1 and submitted it.");
    await second.settle();
    const view = await second.observe();
    expect(view).toContain("Velkommen");
    // The page shows the username; the model sees it hidden.
    expect(view).not.toContain(USER);
    expect(view).not.toContain(PASSWORD);

    // The same form on another host gets nothing.
    await second.navigate(`http://localhost:${port}/login`);
    await expect(second.login()).rejects.toThrow(ActionError);
    await expect(second.login()).rejects.toThrow(/no saved login for localhost/);
    await second.close();
  });

  it("handles a two-step login", async () => {
    const store = new LoginStore(undefined);
    store.save("room", { host: "127.0.0.1", username: USER, password: PASSWORD, savedAt: 1 });
    const session = await open();
    session.useLogins((host) => store.find("room", host), [USER, PASSWORD]);
    await session.navigate(`${base()}/step1`);
    expect(await session.login()).toMatch(/saved username and went on/);
    await session.settle();
    expect(await session.observe()).toContain("Steg 2");
    expect(await session.login()).toMatch(/saved login for 127.0.0.1/);
    await session.settle();
    expect(await session.observe()).toContain("Velkommen");
    await session.close();
  });

  it("keeps a blocked browser off localhost and the local network", async () => {
    const session = await BrowserSession.open({
      profileDir: mkdtempSync(join(tmpdir(), "nudge-login-")),
      headless: true,
      blockPrivateNetwork: true,
    });
    await expect(session.navigate(`${base()}/login`)).rejects.toThrow(/local or private network/);
    // Requests a page makes are refused too, not only navigations by the agent.
    await session.page.setContent("<h1>Outside</h1>");
    const status = await session.page.evaluate(
      `fetch("${base()}/home").then(() => "reached", () => "refused")`,
    );
    expect(status).toBe("refused");
    await session.close();
  });
});
