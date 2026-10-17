import type { Apns, Fcm } from "@nudge/ext-push";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { Handles, MAX_HANDLE } from "./handles.ts";
import { Limits } from "./limits.ts";

const NAMES = { apns: "APNs", fcm: "FCM" } as const;

/** Most bytes of a sealed push: APNs takes 4 KiB in all, and the alert needs some. */
const MAX_SEALED = 3000;

/** What an app sends to get a handle for its device. */
export const RegisterRequest = Type.Object({
  platform: Type.Union([Type.Literal("apns"), Type.Literal("fcm")]),
  token: Type.String({ minLength: 1, maxLength: 4096 }),
  environment: Type.Optional(Type.Union([Type.Literal("production"), Type.Literal("sandbox")])),
});

/** What a host sends to push to a device through the relay. */
export const SendRequest = Type.Object({
  handle: Type.String({ minLength: 1, maxLength: MAX_HANDLE }),
  /** The push sealed for the device (`sealForDevice`); the relay passes it on as it is. */
  sealed: Type.String({ minLength: 1, maxLength: MAX_SEALED }),
  /** Pushes with the same one replace each other; at most 64 characters. */
  collapseId: Type.Optional(Type.String({ maxLength: 64 })),
});

export type RelayOptions = {
  /** Encrypts handles; 32 bytes. Losing it makes every handle unreadable, so apps register anew. */
  readonly handleKey: Buffer;
  /** The published apps' APNs key; without it the relay takes no Apple devices. */
  readonly apns?: Apns;
  /** The published Android app's Firebase project; without it the relay takes no Android devices. */
  readonly fcm?: Fcm;
  /** Who sent a request, for rate limits; default the socket's address. */
  readonly address?: (c: Context) => string;
  /** Pushes a sender (by address) may make a minute; default 120. */
  readonly perAddressPerMinute?: number;
  /** Pushes one device may get a minute; default 30. */
  readonly perDevicePerMinute?: number;
  readonly report?: (error: unknown) => void;
  readonly now?: () => number;
};

/**
 * The push relay (ADR 10): hosts can't hold the published apps' APNs key or Firebase service
 * account, so they push to those apps through the relay the project runs. An app registers its
 * device token and gets a handle; a host it signs in to gets the handle and the device's own key,
 * and sends pushes sealed for that key. The relay reads neither: it opens the handle and passes
 * the sealed push to APNs or FCM, whose notification the app decrypts on the device.
 */
export function relayApp(options: RelayOptions): Hono {
  const handles = new Handles(options.handleKey);
  const now = options.now ?? Date.now;
  const perAddress = options.perAddressPerMinute ?? 120;
  const perDevice = options.perDevicePerMinute ?? 30;
  const senders = new Limits(perAddress, perAddress, now);
  const devices = new Limits(perDevice, perDevice, now);
  const registrations = new Limits(perAddress, perAddress, now);
  const report = options.report ?? ((error) => console.error("relay:", error));
  const address = options.address ?? ((c: Context) => c.env?.incoming?.socket?.remoteAddress ?? "");

  const app = new Hono();
  app.use(bodyLimit({ maxSize: 16 * 1024, onError: (c) => problem(c, 413, "Too large") }));

  app.get("/", (c) =>
    c.json({ relay: "nudge", apns: options.apns !== undefined, fcm: options.fcm !== undefined }),
  );

  app.post("/v1/register", async (c) => {
    if (!registrations.take(address(c))) return problem(c, 429, "Too many requests");
    const body = await readBody(c, RegisterRequest);
    if (body instanceof Response) return body;
    if (options[body.platform] === undefined)
      return problem(c, 400, `This relay sends no ${NAMES[body.platform]} pushes`);
    if (body.platform === "apns" && !/^[0-9a-f]{16,200}$/i.test(body.token))
      return problem(c, 400, "An APNs device token is hex");
    const environment = body.platform === "apns" ? (body.environment ?? "production") : undefined;
    return c.json({
      handle: handles.make({
        platform: body.platform,
        token: body.token,
        ...(environment === undefined ? {} : { environment }),
      }),
    });
  });

  app.post("/v1/send", async (c) => {
    if (!senders.take(address(c))) return problem(c, 429, "Too many requests");
    const body = await readBody(c, SendRequest);
    if (body instanceof Response) return body;
    const device = handles.read(body.handle);
    // Not made here, or under a key the relay no longer has: the app must register again.
    if (device === undefined) return problem(c, 410, "Unknown handle");
    if (!devices.take(`${device.platform}:${device.token}`))
      return problem(c, 429, "Too many pushes to this device");
    const collapseId = body.collapseId ?? "nudge";
    let result: "sent" | "gone";
    try {
      if (device.platform === "apns") {
        const apns = options.apns;
        if (apns === undefined) return problem(c, 410, "This relay sends no APNs pushes");
        // Shown as it is only if the app can't decrypt it.
        result = await apns.send(device.token, device.environment ?? "production", {
          title: "Nudge",
          body: "New message",
          collapseId,
          threadId: collapseId,
          data: { sealed: body.sealed },
          mutableContent: true,
        });
      } else {
        const fcm = options.fcm;
        if (fcm === undefined) return problem(c, 410, "This relay sends no FCM pushes");
        result = await fcm.send(device.token, {
          collapseKey: collapseId,
          data: { sealed: body.sealed },
        });
      }
    } catch (error) {
      report(error);
      return problem(c, 502, "The push service failed");
    }
    return result === "gone" ? problem(c, 410, "The device is gone") : c.body(null, 204);
  });

  return app;
}

async function readBody<S extends TSchema>(c: Context, schema: S): Promise<Static<S> | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return problem(c, 400, "The body is not JSON");
  }
  if (!Value.Check(schema, body)) {
    const first = [...Value.Errors(schema, body)][0];
    return problem(c, 400, `Invalid body: ${first?.instancePath || "/"} ${first?.message ?? ""}`);
  }
  return body as Static<S>;
}

function problem(c: Context, status: 400 | 410 | 413 | 429 | 502, message: string): Response {
  return c.json({ error: message }, status);
}
