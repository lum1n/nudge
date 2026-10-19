// The desktop, live, for the people in the room: its screen as pictures, and their pointer and
// keys, through the same XTest input the agent's clicks use. Nothing of this goes to a model.
import { closeSync, openSync, readSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import type { DesktopSession } from "./session.ts";

/** What the live view's client sends. Coordinates are in screen pixels. */
export type LiveInput =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean }
  | { type: "move"; x: number; y: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  /** Starts one of the apps the settings allow. */
  | { type: "launch"; app: string }
  /** Brings a window to the front: there is no window manager to click. */
  | { type: "raise"; ref: string }
  /** Handled by the extension: become the one who controls the desktop. */
  | { type: "take" };

/**
 * What the live view sends. A frame is a PNG of the part of the screen that changed, to draw at
 * `x`, `y` over the last; the first one a viewer gets is the whole screen.
 */
export type LiveOutput =
  | {
      type: "frame";
      data: string;
      x: number;
      y: number;
      width: number;
      height: number;
      screen: { width: number; height: number };
    }
  | { type: "windows"; windows: { ref: string; title: string; app: string }[] }
  | { type: "apps"; apps: string[] }
  /** What the desktop agent is doing, while it works; empty when it is done. */
  | { type: "status"; text: string }
  | { type: "error"; message: string }
  /** Who controls the desktop; only they can click and type. */
  | { type: "control"; holder?: string; you: boolean };

/** How often the screen is looked at for changes while someone watches. */
const FRAME_MS = 100;
/** How often the window list is read again while the screen changes. */
const WINDOWS_MS = 1_000;

/**
 * A screen as Xvfb keeps it in its framebuffer file (XWD: a big-endian header, a colour map, then
 * the pixels), read whole on each look, and the part that changed since the last, as a PNG.
 */
export class Framebuffer {
  private readonly path: string;
  private buffer = Buffer.alloc(0);
  private last: Buffer | undefined;
  width = 0;
  height = 0;
  private offset = 0;
  private stride = 0;
  /** Bytes of each pixel's red, green and blue, by the masks and byte order the header gives. */
  private channels: [number, number, number] = [2, 1, 0];

  constructor(path: string) {
    this.path = path;
  }

  /** Reads the screen; false when there is no framebuffer (yet). */
  read(): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return false;
    }
    try {
      const header = Buffer.alloc(100);
      if (readSync(fd, header, 0, 100, 0) < 100) return false;
      const field = (i: number) => header.readUInt32BE(i * 4);
      const [headerSize, depth, width, height] = [field(0), field(3), field(4), field(5)];
      const [byteOrder, bitsPerPixel, stride] = [field(7), field(11), field(12)];
      if (bitsPerPixel !== 32 || depth < 24) return false;
      const masks = [field(14), field(15), field(16)];
      // Byte n of a pixel holds mask 0xff << 8n when the order is LSB first (0), else the reverse.
      this.channels = masks.map((mask) => {
        const shift = Math.log2(mask & -mask) / 8;
        return byteOrder === 0 ? shift : 3 - shift;
      }) as [number, number, number];
      this.offset = headerSize + field(19) * 12;
      this.width = width;
      this.height = height;
      this.stride = stride;
      const size = stride * height;
      if (this.buffer.length !== size) this.buffer = Buffer.alloc(size);
      return readSync(fd, this.buffer, 0, size, this.offset) === size;
    } finally {
      closeSync(fd);
    }
  }

  /** The whole screen as a PNG. */
  whole(): Box {
    const { width, height } = this;
    return { data: this.png(0, 0, width, height), x: 0, y: 0, width, height };
  }

  /** The box around what changed since the last look, as a PNG; undefined when nothing did. */
  changed(): Box | undefined {
    const last = this.last;
    if (last === undefined || last.length !== this.buffer.length) {
      this.last = Buffer.from(this.buffer);
      return this.whole();
    }
    const { stride, height, width } = this;
    let top = -1;
    let bottom = -1;
    for (let row = 0; row < height; row++) {
      const start = row * stride;
      if (this.buffer.compare(last, start, start + width * 4, start, start + width * 4) !== 0) {
        if (top < 0) top = row;
        bottom = row;
      }
    }
    if (top < 0) return undefined;
    // Columns in blocks of 32 pixels: close enough, and quick.
    const block = 32;
    let left = width;
    let right = 0;
    for (let row = top; row <= bottom; row++) {
      const start = row * stride;
      for (let x = 0; x < width; x += block) {
        const end = Math.min(width, x + block);
        if (x >= left && end <= right) continue;
        const a = start + x * 4;
        const b = start + end * 4;
        if (this.buffer.compare(last, a, b, a, b) !== 0) {
          left = Math.min(left, x);
          right = Math.max(right, end);
        }
      }
    }
    for (let row = top; row <= bottom; row++) {
      const start = row * stride;
      this.buffer.copy(last, start + left * 4, start + left * 4, start + right * 4);
    }
    return {
      data: this.png(left, top, right - left, bottom - top + 1),
      x: left,
      y: top,
      width: right - left,
      height: bottom - top + 1,
    };
  }

  /** A PNG of a box of the screen: RGB rows, each filtered against the one above (Up). */
  private png(x: number, y: number, width: number, height: number): Buffer {
    const [r, g, b] = this.channels;
    const row = 1 + width * 3;
    const raw = Buffer.alloc(row * height);
    for (let j = 0; j < height; j++) {
      const out = j * row;
      raw[out] = j === 0 ? 0 : 2;
      const from = (y + j) * this.stride + x * 4;
      const above = from - this.stride;
      for (let i = 0; i < width; i++) {
        const p = from + i * 4;
        const o = out + 1 + i * 3;
        if (j === 0) {
          raw[o] = this.buffer[p + r]!;
          raw[o + 1] = this.buffer[p + g]!;
          raw[o + 2] = this.buffer[p + b]!;
        } else {
          const q = above + i * 4;
          raw[o] = (this.buffer[p + r]! - this.buffer[q + r]!) & 0xff;
          raw[o + 1] = (this.buffer[p + g]! - this.buffer[q + g]!) & 0xff;
          raw[o + 2] = (this.buffer[p + b]! - this.buffer[q + b]!) & 0xff;
        }
      }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bits per channel
    header[9] = 2; // RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw, { level: 3 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

type Box = { data: Buffer; x: number; y: number; width: number; height: number };

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export interface LiveView {
  /** Sends the whole screen and the windows to a viewer who just came. */
  welcome(send: (output: LiveOutput) => void): Promise<void>;
  /** Input from the viewer in control; what goes wrong goes back through `reply`. */
  receive(data: string, reply: (output: LiveOutput) => void): void;
  close(): void;
}

/**
 * Streams the desktop's screen to its viewers through `broadcast`, as it changes, and replays the
 * input of the one in control.
 */
export function startLiveView(
  session: DesktopSession,
  broadcast: (output: LiveOutput) => void,
): LiveView {
  const screen = new Framebuffer(session.framebuffer);
  let closed = false;
  let windowsAt = 0;
  let lastWindows = "";

  const sendWindows = async (send: (output: LiveOutput) => void, always: boolean) => {
    windowsAt = Date.now();
    const windows = await session.windowList().catch(() => undefined);
    if (windows === undefined) return;
    const text = JSON.stringify(windows);
    if (!always && text === lastWindows) return;
    lastWindows = text;
    send({ type: "windows", windows });
  };

  const frame = (box: Box): LiveOutput => ({
    type: "frame",
    data: box.data.toString("base64"),
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    screen: { width: screen.width, height: screen.height },
  });

  let busy = false;
  const timer = setInterval(() => {
    if (busy || closed) return;
    busy = true;
    void (async () => {
      if (!screen.read()) return;
      const box = screen.changed();
      if (box) broadcast(frame(box));
      if (box && Date.now() - windowsAt > WINDOWS_MS) await sendWindows(broadcast, false);
    })().finally(() => {
      busy = false;
    });
  }, FRAME_MS);
  timer.unref();

  const handle = async (input: LiveInput) => {
    const atspi = session.atspi;
    switch (input.type) {
      case "click": {
        const button = { left: 1, middle: 2, right: 3 }[input.button ?? "left"];
        await atspi.mouse(input.x, input.y, "abs");
        if (input.double) return atspi.mouse(input.x, input.y, `b${button}d`);
        await atspi.mouse(input.x, input.y, `b${button}p`);
        await sleep(30);
        return atspi.mouse(input.x, input.y, `b${button}r`);
      }
      case "move":
        return atspi.mouse(input.x, input.y, "abs");
      case "wheel": {
        await atspi.mouse(input.x, input.y, "abs");
        // Buttons 4 and 5 scroll up and down, 6 and 7 left and right; a notch is about 100.
        const steps = (delta: number) =>
          Math.min(10, Math.max(1, Math.round(Math.abs(delta) / 100)));
        if (input.dy)
          for (let i = 0; i < steps(input.dy); i++)
            await atspi.mouse(input.x, input.y, input.dy < 0 ? "b4c" : "b5c");
        if (input.dx)
          for (let i = 0; i < steps(input.dx); i++)
            await atspi.mouse(input.x, input.y, input.dx < 0 ? "b6c" : "b7c");
        return;
      }
      case "key":
        return atspi.key(input.key);
      case "text":
        return atspi.typeString(input.text);
      case "launch":
        await session.launch(input.app);
        return sendWindows(broadcast, true);
      case "raise":
        await session.focusWindow(input.ref);
        return sendWindows(broadcast, true);
      default:
        return;
    }
  };

  let queue = Promise.resolve();
  return {
    welcome: async (send) => {
      if (screen.read()) {
        // What changed goes to the others first, so the whole screen is the newcomer's start.
        const box = screen.changed();
        if (box) broadcast(frame(box));
        send(frame(screen.whole()));
      }
      await sendWindows(send, true);
    },
    receive: (data, reply) => {
      queue = queue
        .then(() => handle(JSON.parse(data) as LiveInput))
        .catch((error: unknown) =>
          reply({
            type: "error",
            message: (error instanceof Error ? error.message : String(error)).split("\n")[0]!,
          }),
        );
    },
    close: () => {
      closed = true;
      clearInterval(timer);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
