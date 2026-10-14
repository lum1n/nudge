import type { CDPSession, Page } from "patchright";
import type { BrowserSession } from "./browser.ts";

/** What the live view's client sends. Coordinates are in page (viewport) pixels. */
export type LiveInput =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean }
  | { type: "move"; x: number; y: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string }
  | { type: "done"; remember: boolean }
  /** Handled by the extension: become the one who controls the browser. */
  | { type: "take" }
  /** Handled by the extension: drop a saved login. */
  | { type: "forget"; host: string };

/** What the live view sends: JPEG frames of the current tab, and answers. */
export type LiveOutput =
  | { type: "frame"; data: string; width: number; height: number; url: string }
  | { type: "done"; saved: string[] }
  | { type: "error"; message: string }
  /** Who controls the browser; only they can click and type. */
  | { type: "control"; holder?: string; you: boolean }
  /** The room's saved logins, without their passwords. */
  | { type: "logins"; logins: { host: string; username?: string; savedAt: number }[] };

export interface LiveView {
  receive(data: string): void;
  close(): void;
}

/**
 * Streams the session's current tab to one viewer and replays their input. Before any click or
 * Enter reaches the page, the login fields are read, so a login typed here can be saved on `done`.
 * Nothing of this goes to a model.
 */
export async function startLiveView(
  session: BrowserSession,
  send: (output: LiveOutput) => void,
  onDone: (remember: boolean) => string[],
): Promise<LiveView> {
  let cdp: CDPSession | undefined;
  let closed = false;

  const cast = async (page: Page) => {
    const previous = cdp;
    cdp = undefined;
    await previous?.send("Page.stopScreencast").catch(() => {});
    await previous?.detach().catch(() => {});
    if (closed) return;
    const next = await page.context().newCDPSession(page);
    cdp = next;
    next.on("Page.screencastFrame", (frame) => {
      if (cdp !== next) return;
      send({
        type: "frame",
        data: frame.data,
        width: frame.metadata.deviceWidth,
        height: frame.metadata.deviceHeight,
        url: page.url(),
      });
      void next.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    const size = page.viewportSize() ?? { width: 1280, height: 900 };
    await next.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: size.width,
      maxHeight: size.height,
    });
  };

  await cast(session.page);
  const stopFollowing = session.onPageChange((page) => void cast(page));

  const handle = async (input: LiveInput) => {
    const page = session.page;
    switch (input.type) {
      case "click":
        await session.captureLogin();
        await page.mouse.click(input.x, input.y, {
          button: input.button ?? "left",
          clickCount: input.double ? 2 : 1,
        });
        return;
      case "move":
        await page.mouse.move(input.x, input.y);
        return;
      case "wheel":
        await page.mouse.move(input.x, input.y);
        await page.mouse.wheel(input.dx, input.dy);
        return;
      case "key":
        if (input.key === "Enter") await session.captureLogin();
        await page.keyboard.press(input.key);
        return;
      case "text":
        await page.keyboard.type(input.text);
        return;
      case "navigate":
        await session.navigate(input.url);
        return;
      case "done":
        await session.captureLogin();
        send({ type: "done", saved: onDone(input.remember) });
        return;
      default:
        return;
    }
  };

  let queue = Promise.resolve();
  return {
    receive: (data) => {
      queue = queue
        .then(() => handle(JSON.parse(data) as LiveInput))
        .catch((error: unknown) => send({ type: "error", message: String(error).split("\n")[0]! }));
    },
    close: () => {
      closed = true;
      stopFollowing();
      void cdp?.send("Page.stopScreencast").catch(() => {});
      void cdp?.detach().catch(() => {});
      cdp = undefined;
    },
  };
}
