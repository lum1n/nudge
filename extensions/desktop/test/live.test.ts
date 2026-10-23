// The live view's screen reading, on a framebuffer file made here; and, with
// NUDGE_DESKTOP_TESTS=1, on a real desktop with the GTK app, sandboxed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Framebuffer, type LiveOutput, startLiveView } from "../src/live.ts";
import { DesktopSession } from "../src/session.ts";

const run = process.env.NUDGE_DESKTOP_TESTS === "1";
const fixtures = new URL("./fixtures", import.meta.url).pathname;

/** An XWD file as Xvfb keeps its screen: 32-bit pixels, LSB first, red in the third byte. */
function xwd(width: number, height: number, pixel: (x: number, y: number) => number): Buffer {
  const header = Buffer.alloc(100 + 8);
  const fields = [108, 7, 2, 24, width, height, 0, 0, 32, 0, 32, 32, width * 4, 4];
  fields.forEach((value, i) => header.writeUInt32BE(value, i * 4));
  header.writeUInt32BE(0xff0000, 14 * 4);
  header.writeUInt32BE(0x00ff00, 15 * 4);
  header.writeUInt32BE(0x0000ff, 16 * 4);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) pixels.writeUInt32LE(pixel(x, y), (y * width + x) * 4);
  return Buffer.concat([header, pixels]);
}

/** A PNG's pixels as RGB rows, undoing the Up filter `Framebuffer` writes. */
function decode(png: Buffer): {
  width: number;
  height: number;
  rgb: (x: number, y: number) => number[];
} {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat = png.indexOf("IDAT");
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  const row = 1 + width * 3;
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let i = 0; i < width * 3; i++) {
      const up = raw[y * row] === 2 && y > 0 ? out[(y - 1) * width * 3 + i]! : 0;
      out[y * width * 3 + i] = (raw[y * row + 1 + i]! + up) & 0xff;
    }
  return {
    width,
    height,
    rgb: (x, y) => [...out.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)],
  };
}

describe("the framebuffer", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nudge-fb-test-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the screen whole, then only the box that changed", () => {
    const path = join(dir, "Xvfb_screen0");
    writeFileSync(
      path,
      xwd(100, 50, (x) => (x < 50 ? 0xff0000 : 0x0000ff)),
    );
    const screen = new Framebuffer(path);
    expect(screen.read()).toBe(true);
    const first = screen.changed()!;
    expect([first.x, first.y, first.width, first.height]).toEqual([0, 0, 100, 50]);
    const whole = decode(first.data);
    expect(whole.rgb(10, 10)).toEqual([255, 0, 0]);
    expect(whole.rgb(90, 40)).toEqual([0, 0, 255]);

    expect(screen.read()).toBe(true);
    expect(screen.changed()).toBeUndefined();

    writeFileSync(
      path,
      xwd(100, 50, (x, y) =>
        x >= 40 && x < 45 && y >= 20 && y < 30 ? 0x00ff00 : x < 50 ? 0xff0000 : 0x0000ff,
      ),
    );
    screen.read();
    const box = screen.changed()!;
    // Rows exactly, columns in blocks of 32 pixels.
    expect([box.x, box.y, box.width, box.height]).toEqual([32, 20, 32, 10]);
    const part = decode(box.data);
    expect(part.rgb(40 - 32, 0)).toEqual([0, 255, 0]);
    expect(part.rgb(0, 0)).toEqual([255, 0, 0]);
  });

  it("says so when there is no framebuffer yet", () => {
    expect(new Framebuffer(join(dir, "missing")).read()).toBe(false);
  });
});

describe.runIf(run)("a sandboxed desktop, live", () => {
  let desktop: DesktopSession;
  let dir: string;
  let home: string;
  let secret: string;
  let closed = false;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "nudge-live-test-"));
    home = join(dir, "home");
    secret = join(dir, "secret");
    mkdirSync(secret);
    writeFileSync(join(secret, "key.txt"), "not for apps");
    process.env.NUDGE_TEST_SECRET = "hunter2";
    // What the app sees of the machine, written to its home before it starts.
    const look = `ls "${secret}" > "$HOME/secret.txt" 2>&1; env > "$HOME/env.txt"; ls "${dir}" > "$HOME/dir.txt"; exec python3 "${fixtures}/notes.py" "$HOME/saved.txt"`;
    desktop = await DesktopSession.open({
      homeDir: home,
      apps: { notes: ["sh", "-c", look] },
      sandbox: { readable: [fixtures] },
    });
    expect(await desktop.launch("notes")).toBe("Started notes.");
    await desktop.settle();
  }, 30_000);

  afterAll(async () => {
    delete process.env.NUDGE_TEST_SECRET;
    if (!closed) await desktop?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows the app only the system and its own home", () => {
    expect(readFileSync(join(home, "secret.txt"), "utf8")).toMatch(/No such file/);
    const env = readFileSync(join(home, "env.txt"), "utf8");
    expect(env).not.toMatch(/NUDGE_TEST_SECRET/);
    expect(env).toMatch(new RegExp(`^HOME=${home}$`, "m"));
    // Of the directory its home is in, only the home.
    expect(readFileSync(join(home, "dir.txt"), "utf8")).toBe("home\n");
  });

  it("streams the screen, and takes a viewer's clicks and keys", async () => {
    const sent: LiveOutput[] = [];
    const live = startLiveView(desktop, (output) => sent.push(output));
    try {
      const welcomed: LiveOutput[] = [];
      await live.welcome((output) => welcomed.push(output));
      sent.length = 0;
      const frame = welcomed.find((output) => output.type === "frame");
      expect(frame).toMatchObject({ x: 0, y: 0, width: 1280, height: 800 });
      expect(welcomed.find((output) => output.type === "windows")).toMatchObject({
        windows: [{ title: "Notes" }],
      });

      // The Title field, where the window opens at the top left corner.
      const errors: LiveOutput[] = [];
      live.receive(JSON.stringify({ type: "click", x: 300, y: 87 }), (o) => errors.push(o));
      live.receive(JSON.stringify({ type: "text", text: "From a person" }), (o) => errors.push(o));
      await desktop.settle();
      expect(errors).toEqual([]);
      expect(await desktop.observe()).toMatch(
        /textbox "Title" \[focused\] \[e\d+\]: From a person/,
      );

      // Dragged across the field from its right end, the text is selected and typed over.
      live.receive(
        JSON.stringify({ type: "drag", from: { x: 600, y: 87 }, to: { x: 0, y: 87 } }),
        (o) => errors.push(o),
      );
      live.receive(JSON.stringify({ type: "text", text: "Dragged" }), (o) => errors.push(o));
      await desktop.settle();
      expect(errors).toEqual([]);
      expect(await desktop.observe()).toMatch(/textbox "Title" \[focused\] \[e\d+\]: Dragged$/m);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const changed = sent.filter((output) => output.type === "frame");
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.every((output) => output.type === "frame" && output.width < 1280)).toBe(true);
    } finally {
      live.close();
    }
  }, 30_000);

  it("lets the apps quit before their display goes", async () => {
    closed = true;
    await desktop.close();
    expect(readFileSync(join(home, "saved.txt"), "utf8")).toBe("quit\n");
  }, 30_000);
});
