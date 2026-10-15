import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily } from "@earendil-works/pi-durable";
import { DirectoryDoc, type Nudge, type RoomEvent } from "@nudge/core";
import { Apns, type ApnsEnvironment, type ApnsOptions } from "./apns.ts";
import { Fcm, type FcmOptions } from "./fcm.ts";
import { type PushOptions, type PushTarget, sendPush } from "./web-push.ts";

const context = BACKGROUND_CONTEXT;

// Stored in a document, so plain JSON.
type Subscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The client whose token added it; it stops getting pushes once that token is revoked. */
  clientId: string;
  createdAt: number;
};

// Stored in a document, so plain JSON.
type Device = {
  platform: "apns" | "fcm";
  token: string;
  /** APNs only: apps built for development take pushes through Apple's sandbox. */
  environment?: ApnsEnvironment;
  /** The client whose token added it; it stops getting pushes once that token is revoked. */
  clientId: string;
  createdAt: number;
};

/** Each player's browsers and devices that take pushes, keyed by player id. */
export const PushDoc = defineDocFamily<{ subscriptions: Subscription[]; devices?: Device[] }, null>(
  {
    kind: "nudge.push",
    version: 1,
    scope: "session",
    family: true,
    initial: () => ({ subscriptions: [] }),
  },
);

/** Subscriptions kept per player; a new one beyond this pushes out the oldest. */
const MAX_PER_PLAYER = 10;
/** Characters of an answer shown in its notification. */
const PREVIEW = 240;

/** What the service worker gets, and shows as a notification. */
export type PushMessage = {
  readonly title: string;
  readonly body: string;
  /** The page to open when the notification is clicked, from the site's root. */
  readonly url: string;
  /** Notifications of one room replace each other. */
  readonly tag: string;
  readonly kind: "answer" | "approval";
  readonly roomId: string;
};

export type PushesOptions = PushOptions & {
  /** With a preview, a notification has the start of the answer or approval; default only which room has news. */
  readonly preview?: boolean;
  /** Native pushes to the iOS and macOS apps; none without. */
  readonly apns?: ApnsOptions;
  /** Native pushes to the Android app; none without. */
  readonly fcm?: FcmOptions;
};

/** The native push services a server sends through, shared by its assistants. */
export type NativeSenders = { readonly apns?: Apns; readonly fcm?: Fcm };

export function nativeSenders(options: PushesOptions): NativeSenders {
  return {
    apns: options.apns === undefined ? undefined : new Apns(options.apns),
    fcm: options.fcm === undefined ? undefined : new Fcm(options.fcm),
  };
}

/** What a device registers with. */
export type DeviceTarget = {
  readonly platform: "apns" | "fcm";
  readonly token: string;
  readonly environment?: ApnsEnvironment;
};

export class BadSubscription extends Error {
  override name = "BadSubscription";
}

/**
 * Pushes for one assistant. Players' browsers subscribe, and every room event reaches the
 * browsers of the room's members, encrypted for each; whether one is shown is the service
 * worker's call: not when the room is open in a visible tab. Their phones and Macs register a
 * device, and get the same through APNs or FCM unless the player has the room open on a socket.
 */
export class Pushes {
  private readonly stop: () => void;

  constructor(
    private readonly nudge: Nudge,
    /** The assistant's URL name, for links. */
    private readonly name: string,
    private readonly options: PushesOptions,
    private readonly report: (error: unknown) => void,
    private readonly native: NativeSenders = {},
    /** Whether the player has the room open on a socket right now. */
    private readonly watching: (playerId: string, roomId: string) => boolean = () => false,
  ) {
    this.stop = nudge.events.subscribe((event) => {
      this.notify(event).catch(report);
    });
  }

  get publicKey(): string {
    return this.options.vapid.publicKey;
  }

  async subscribe(playerId: string, clientId: string, target: PushTarget): Promise<void> {
    checkTarget(target);
    await this.nudge.harness.commit(async (tx) => {
      const doc = await tx.doc(PushDoc, playerId, null);
      const kept = doc.subscriptions.filter((s) => s.endpoint !== target.endpoint);
      kept.push({
        endpoint: target.endpoint,
        p256dh: target.keys.p256dh,
        auth: target.keys.auth,
        clientId,
        createdAt: Date.now(),
      });
      doc.subscriptions = kept.slice(-MAX_PER_PLAYER);
    }, context);
  }

  /** False when the player had no such subscription. */
  async unsubscribe(playerId: string, endpoint: string): Promise<boolean> {
    return this.nudge.harness.commit(async (tx) => {
      const doc = await tx.doc(PushDoc, playerId, null);
      const before = doc.subscriptions.length;
      doc.subscriptions = doc.subscriptions.filter((s) => s.endpoint !== endpoint);
      return doc.subscriptions.length < before;
    }, context);
  }

  /** Which native pushes this server sends. */
  get platforms(): { apns: boolean; fcm: boolean } {
    return { apns: this.native.apns !== undefined, fcm: this.native.fcm !== undefined };
  }

  async register(playerId: string, clientId: string, device: DeviceTarget): Promise<void> {
    if (this.native[device.platform] === undefined)
      throw new BadSubscription(`This server sends no ${device.platform.toUpperCase()} pushes`);
    if (device.platform === "apns" && !/^[0-9a-f]{16,200}$/i.test(device.token))
      throw new BadSubscription("An APNs device token is hex");
    await this.nudge.harness.commit(async (tx) => {
      const doc = await tx.doc(PushDoc, playerId, null);
      // A device token moves with the device: whoever registers it last gets its pushes.
      const kept = (doc.devices ?? []).filter((d) => d.token !== device.token);
      kept.push({
        platform: device.platform,
        token: device.token,
        ...(device.platform === "apns" ? { environment: device.environment ?? "production" } : {}),
        clientId,
        createdAt: Date.now(),
      });
      doc.devices = kept.slice(-MAX_PER_PLAYER);
    }, context);
  }

  /** False when the player had no such device. */
  async unregister(playerId: string, token: string): Promise<boolean> {
    return this.nudge.harness.commit(async (tx) => {
      const doc = await tx.doc(PushDoc, playerId, null);
      const before = doc.devices?.length ?? 0;
      doc.devices = (doc.devices ?? []).filter((d) => d.token !== token);
      return doc.devices.length < before;
    }, context);
  }

  close(): void {
    this.stop();
  }

  private async notify(event: RoomEvent): Promise<void> {
    const message = await this.message(event);
    if (message === undefined) return;
    const directory = await this.nudge.harness.snapshot(DirectoryDoc, context);
    const clients = new Set(Object.values(directory?.tokens ?? {}).map((t) => t.clientId));
    const members = await this.nudge.rooms.members(event.roomId, context);
    await Promise.all(
      members.map(async (player) => {
        const doc = await this.nudge.harness.snapshot(PushDoc, player.id, context);
        const gone: string[] = [];
        await Promise.all(
          (doc?.subscriptions ?? []).map(async (subscription) => {
            if (!clients.has(subscription.clientId)) return gone.push(subscription.endpoint);
            const target = {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            };
            try {
              if ((await sendPush(target, message, this.options)) === "gone")
                gone.push(subscription.endpoint);
            } catch (error) {
              this.report(error);
            }
          }),
        );
        for (const endpoint of gone) await this.unsubscribe(player.id, endpoint);
        if (this.watching(player.id, event.roomId)) return;
        const lost: string[] = [];
        await Promise.all(
          (doc?.devices ?? []).map(async (device) => {
            if (!clients.has(device.clientId)) return lost.push(device.token);
            try {
              if ((await this.sendNative(device, message)) === "gone") lost.push(device.token);
            } catch (error) {
              this.report(error);
            }
          }),
        );
        for (const token of lost) await this.unregister(player.id, token);
      }),
    );
  }

  private sendNative(device: Device, message: PushMessage): Promise<"sent" | "gone"> {
    const data = {
      assistant: this.name,
      roomId: message.roomId,
      kind: message.kind,
      url: message.url,
    };
    if (device.platform === "apns") {
      const apns = this.native.apns;
      if (apns === undefined) return Promise.resolve("sent");
      return apns.send(device.token, device.environment ?? "production", {
        title: message.title,
        body: message.body,
        collapseId: message.tag,
        threadId: message.tag,
        data,
      });
    }
    const fcm = this.native.fcm;
    if (fcm === undefined) return Promise.resolve("sent");
    return fcm.send(device.token, {
      collapseKey: message.tag,
      data: { ...data, title: message.title, body: message.body, tag: message.tag },
    });
  }

  private async message(event: RoomEvent): Promise<PushMessage | undefined> {
    const room = await this.nudge.rooms.get(event.roomId, context);
    if (room === undefined) return undefined;
    const base = {
      title: `${this.nudge.displayName} · ${room.name}`,
      url: `/${encodeURIComponent(this.name)}/${encodeURIComponent(room.id)}`,
      tag: `${this.name}/${room.id}`,
      roomId: room.id,
    };
    const preview = this.options.preview ?? false;
    if (event.type === "approval")
      return {
        ...base,
        kind: "approval",
        body: preview
          ? `Waiting for approval: ${clip(event.approval.summary)}`
          : "An action waits for approval",
      };
    if (event.status === "stopped") return undefined;
    if (event.status === "failed")
      return { ...base, kind: "answer", body: `${this.nudge.displayName} couldn't answer` };
    if (event.text === "") return undefined;
    return { ...base, kind: "answer", body: preview ? clip(event.text) : "New message" };
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW ? flat : `${flat.slice(0, PREVIEW - 1)}…`;
}

/**
 * The server will POST to the endpoint, so it must look like a push service: HTTPS on a public
 * name, not an address or a local name.
 */
function checkTarget(target: PushTarget): void {
  let url: URL;
  try {
    url = new URL(target.endpoint);
  } catch {
    throw new BadSubscription("The endpoint is not a URL");
  }
  if (url.protocol !== "https:") throw new BadSubscription("The endpoint must be HTTPS");
  const host = url.hostname.toLowerCase();
  if (
    host.startsWith("[") ||
    /^[\d.]+$/.test(host) ||
    !host.includes(".") ||
    /\.(local|localhost|internal|lan|home\.arpa)$/.test(host) ||
    host === "localhost"
  )
    throw new BadSubscription("The endpoint must be a push service on a public name");
  const p256dh = Buffer.from(target.keys.p256dh, "base64url");
  if (p256dh.length !== 65 || p256dh[0] !== 4)
    throw new BadSubscription("keys.p256dh is not an uncompressed P-256 key");
  if (Buffer.from(target.keys.auth, "base64url").length !== 16)
    throw new BadSubscription("keys.auth is not 16 bytes");
}
