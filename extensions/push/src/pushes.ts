import { createHash, timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily } from "@earendil-works/pi-durable";
import { DirectoryDoc, type Nudge, type RoomEvent } from "@nudge/core";
import type { Apns, ApnsEnvironment } from "./apns.ts";
import { isDeviceKey, sealForDevice } from "./device-seal.ts";
import type { Fcm } from "./fcm.ts";
import type { Relays } from "./relays.ts";
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
  platform: "apns" | "fcm" | "relay";
  /** The APNs or FCM token, or the relay's handle for the device. */
  token: string;
  /** APNs only: apps built for development take pushes through Apple's sandbox. */
  environment?: ApnsEnvironment;
  /** Relay only: where to send, and the device's X25519 key that pushes are sealed for. */
  relay?: string;
  deviceKey?: string;
  /** The app's name for the sign-in that registered it, given back in its pushes. */
  account?: string;
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
};

/** The native push services and relays the assistant sends through; none without. */
export type NativeSenders = { readonly apns?: Apns; readonly fcm?: Fcm; readonly relays?: Relays };

/** What a device registers with. */
export type DeviceTarget =
  | {
      readonly platform: "apns" | "fcm";
      readonly token: string;
      readonly environment?: ApnsEnvironment;
      readonly account?: string;
    }
  | {
      readonly platform: "relay";
      readonly relay: string;
      readonly handle: string;
      readonly deviceKey: string;
      readonly account?: string;
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
  constructor(
    private readonly nudge: () => Nudge,
    /** The assistant's URL name, for links. */
    private readonly name: string,
    private readonly options: PushesOptions,
    private readonly report: (error: unknown) => void,
    private readonly native: NativeSenders = {},
  ) {}

  get publicKey(): string {
    return this.options.vapid.publicKey;
  }

  async subscribe(playerId: string, clientId: string, target: PushTarget): Promise<void> {
    checkTarget(target);
    await this.nudge().harness.commit(async (tx) => {
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
    return this.nudge().harness.commit(async (tx) => {
      const doc = await tx.doc(PushDoc, playerId, null);
      const before = doc.subscriptions.length;
      doc.subscriptions = doc.subscriptions.filter((s) => s.endpoint !== endpoint);
      return doc.subscriptions.length < before;
    }, context);
  }

  /**
   * Swaps a subscription the browser replaced (`pushsubscriptionchange`) for its new one. The
   * service worker has no token, so the old subscription's auth secret, which only the browser
   * and this server know, stands in for it. False when no player has that subscription.
   */
  async renew(old: { endpoint: string; auth: string }, target: PushTarget): Promise<boolean> {
    checkTarget(target);
    const directory = await this.nudge().harness.snapshot(DirectoryDoc, context);
    for (const playerId of Object.keys(directory?.players ?? {})) {
      const seen = await this.nudge().harness.snapshot(PushDoc, playerId, context);
      if (!seen?.subscriptions.some((s) => s.endpoint === old.endpoint)) continue;
      const renewed = await this.nudge().harness.commit(async (tx) => {
        const doc = await tx.doc(PushDoc, playerId, null);
        const found = doc.subscriptions.find(
          (s) => s.endpoint === old.endpoint && sameSecret(s.auth, old.auth),
        );
        if (found === undefined) return false;
        doc.subscriptions = [
          ...doc.subscriptions.filter(
            (s) => s.endpoint !== old.endpoint && s.endpoint !== target.endpoint,
          ),
          {
            endpoint: target.endpoint,
            p256dh: target.keys.p256dh,
            auth: target.keys.auth,
            clientId: found.clientId,
            createdAt: Date.now(),
          },
        ];
        return true;
      }, context);
      if (renewed) return true;
    }
    return false;
  }

  /** Which native pushes this server sends, and through which relays. */
  get platforms(): { apns: boolean; fcm: boolean; relays: string[] } {
    return {
      apns: this.native.apns !== undefined,
      fcm: this.native.fcm !== undefined,
      relays: this.native.relays?.urls ?? [],
    };
  }

  async register(playerId: string, clientId: string, device: DeviceTarget): Promise<void> {
    const stored = this.device(device);
    await this.nudge().harness.commit(async (tx) => {
      const doc = await tx.doc(PushDoc, playerId, null);
      // A device moves between people: whoever registers it last gets its pushes. Behind a relay
      // its key says which device it is, since each registration there makes a new handle.
      const kept = (doc.devices ?? []).filter(
        (d) =>
          d.token !== stored.token &&
          (stored.deviceKey === undefined || d.deviceKey !== stored.deviceKey),
      );
      kept.push({ ...stored, clientId, createdAt: Date.now() });
      doc.devices = kept.slice(-MAX_PER_PLAYER);
    }, context);
  }

  private device(device: DeviceTarget): Omit<Device, "clientId" | "createdAt"> {
    if (device.account !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(device.account))
      throw new BadSubscription("account is 1 to 64 letters, digits, - or _");
    const account = device.account === undefined ? {} : { account: device.account };
    if (device.platform === "relay") {
      const relay = this.native.relays?.find(device.relay);
      if (relay === undefined)
        throw new BadSubscription(`This server sends no pushes through ${device.relay}`);
      if (!isDeviceKey(device.deviceKey))
        throw new BadSubscription("deviceKey is not an X25519 key");
      if (!/^[A-Za-z0-9._~-]+$/.test(device.handle))
        throw new BadSubscription("The handle is not what a relay makes");
      return {
        platform: "relay",
        token: device.handle,
        relay,
        deviceKey: device.deviceKey,
        ...account,
      };
    }
    if (this.native[device.platform] === undefined)
      throw new BadSubscription(
        `This server sends no ${device.platform === "apns" ? "APNs" : "FCM"} pushes`,
      );
    if (device.platform === "apns" && !/^[0-9a-f]{16,200}$/i.test(device.token))
      throw new BadSubscription("An APNs device token is hex");
    return {
      platform: device.platform,
      token: device.token,
      ...(device.platform === "apns" ? { environment: device.environment ?? "production" } : {}),
      ...account,
    };
  }

  /** False when the player had no such device. */
  async unregister(playerId: string, token: string): Promise<boolean> {
    return this.nudge().harness.commit(async (tx) => {
      const doc = await tx.doc(PushDoc, playerId, null);
      const before = doc.devices?.length ?? 0;
      doc.devices = (doc.devices ?? []).filter((d) => d.token !== token);
      return doc.devices.length < before;
    }, context);
  }

  close(): void {
    this.native.apns?.close();
  }

  /** Passes the event on to the room's members; one that fails is reported, not thrown. */
  async notify(event: RoomEvent): Promise<void> {
    const nudge = this.nudge();
    const directory = await nudge.harness.snapshot(DirectoryDoc, context);
    const clients = new Set(Object.values(directory?.tokens ?? {}).map((t) => t.clientId));
    const privateTo =
      event.type === "answer" ? event.privateTo?.playerId : event.approval.privateTo?.playerId;
    const members = (await nudge.rooms.members(event.roomId, context)).filter(
      (player) => privateTo === undefined || player.id === privateTo,
    );
    await Promise.all(
      members.map(async (player) => {
        // Each member's preview shows only what they may see.
        const message = await this.message(event, player.id);
        if (message === undefined) return;
        const { notifications } = (await nudge.profiles.get(player.id, context)) ?? {};
        if (notifications?.[message.kind === "answer" ? "answers" : "approvals"] === false) return;
        const doc = await nudge.harness.snapshot(PushDoc, player.id, context);
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
        if (nudge.presence.isOpen(player.id, event.roomId)) return;
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
      ...(device.account === undefined ? {} : { account: device.account }),
    };
    if (device.platform === "relay") {
      const relays = this.native.relays;
      const relay = device.relay === undefined ? undefined : relays?.find(device.relay);
      // A relay the admin no longer lists: the device must register again.
      if (relays === undefined || relay === undefined || device.deviceKey === undefined)
        return Promise.resolve("gone");
      return relays.send(relay, {
        handle: device.token,
        sealed: sealForDevice(device.deviceKey, {
          ...data,
          title: message.title,
          body: message.body,
          tag: message.tag,
        }),
        // The relay and Apple see it, so not the room's name: a hash still groups a room's pushes.
        collapseId: createHash("sha256").update(message.tag).digest("base64url").slice(0, 22),
      });
    }
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

  private async message(event: RoomEvent, playerId: string): Promise<PushMessage | undefined> {
    const nudge = this.nudge();
    const show = (text: string) => nudge.showTo(playerId, text);
    const room = await nudge.rooms.get(event.roomId, context);
    if (room === undefined) return undefined;
    const base = {
      title: `${nudge.displayName} · ${room.name}`,
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
          ? `Waiting for approval: ${clip(show(event.approval.summary))}`
          : "An action waits for approval",
      };
    if (event.status === "stopped") return undefined;
    if (event.status === "failed")
      return { ...base, kind: "answer", body: `${nudge.displayName} couldn't answer` };
    if (event.text === "") return undefined;
    return { ...base, kind: "answer", body: preview ? clip(show(event.text)) : "New message" };
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW ? flat : `${flat.slice(0, PREVIEW - 1)}…`;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
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
