import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineNudgeExtension, type ExtensionRoute, Type } from "@nudge/core";
import {
  DeviceRequest,
  type DevicesResponse,
  type PushKeyResponse,
  PushRenewRequest,
  PushSubscribeRequest,
} from "@nudge/protocol";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { Apns } from "./apns.ts";
import { Fcm, type ServiceAccount } from "./fcm.ts";
import { BadSubscription, Pushes } from "./pushes.ts";
import { Relays } from "./relays.ts";
import { generateVapidKeys, type VapidKeys } from "./web-push.ts";

const VERSION = "0.1.0";

const Settings = Type.Object({
  preview: Type.Union([Type.Literal("room"), Type.Literal("text")], {
    default: "room",
    title: "Preview",
    description:
      "room says only which room has news; text adds the start of the answer, which then passes through the push services.",
  }),
  subject: Type.String({
    pattern: "^(mailto|https):",
    default: "https://github.com/lum1n/nudge",
    title: "Contact",
    description: "A mailto: or https: address push services can reach this server's owner at.",
  }),
  apns: Type.Optional(
    Type.Object(
      {
        keyFile: Type.String({
          minLength: 1,
          title: "Key file",
          description: "The .p8 key's path, absolute or from the directory nudge runs in.",
        }),
        keyId: Type.String({ minLength: 1, title: "Key id" }),
        teamId: Type.String({ minLength: 1, title: "Team id" }),
        bundleId: Type.String({ minLength: 1, default: "app.nudge.dev", title: "Bundle id" }),
      },
      {
        title: "APNs",
        description:
          "Pushes to the iOS and macOS apps, with a key from an Apple Developer account.",
      },
    ),
  ),
  fcm: Type.Optional(
    Type.Object(
      {
        serviceAccountFile: Type.String({
          minLength: 1,
          title: "Service account file",
          description:
            "The service account's JSON key, absolute or from the directory nudge runs in.",
        }),
      },
      { title: "FCM", description: "Pushes to the Android app, through a Firebase project." },
    ),
  ),
  relays: Type.Array(Type.String({ pattern: "^https?://" }), {
    default: [],
    title: "Relays",
    description:
      "Push relays to reach the published apps through, whose APNs key and Firebase project only the relay has. Pushes are sealed for each device, so a relay reads nothing.",
  }),
});

export type PushExtensionOptions = {
  /** How pushes reach browsers' push services, FCM and relays; tests pass a fake. */
  readonly fetch?: typeof fetch;
  /** For tests: where to reach APNs and FCM instead of Apple's and Google's hosts. */
  readonly apnsOrigins?: { readonly production: string; readonly sandbox: string };
  readonly fcmOrigin?: string;
  readonly report?: (error: unknown) => void;
};

/**
 * Notifications of answers and approvals: Web Push to browsers, APNs to the iOS and macOS apps
 * and FCM to the Android app. The default export uses the global `fetch`.
 */
export function pushExtension(options: PushExtensionOptions = {}) {
  return defineNudgeExtension({
    name: "push",
    version: VERSION,
    description:
      "Tells people of answers and approvals in their rooms on their browsers, phones and Macs while they're away.",
    settings: Settings,
    setup: (host) => {
      const report = options.report ?? ((error) => console.error("push:", error));
      const { apns, fcm } = host.settings;
      const pushes = new Pushes(
        host.assistant,
        host.name,
        {
          vapid: vapidKeys(host.dataDir),
          subject: host.settings.subject,
          preview: host.settings.preview === "text",
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        },
        report,
        {
          apns:
            apns === undefined
              ? undefined
              : new Apns({
                  key: readSetting(apns.keyFile, "apns.keyFile"),
                  keyId: apns.keyId,
                  teamId: apns.teamId,
                  bundleId: apns.bundleId,
                  ...(options.apnsOrigins === undefined ? {} : { origins: options.apnsOrigins }),
                }),
          fcm:
            fcm === undefined
              ? undefined
              : new Fcm({
                  serviceAccount: serviceAccount(fcm.serviceAccountFile),
                  ...(options.fcmOrigin === undefined ? {} : { origin: options.fcmOrigin }),
                  ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                }),
          relays: new Relays(host.settings.relays, options.fetch),
        },
      );
      return {
        routes: routes(pushes),
        // Sent in the background: a slow push service must not hold up other extensions.
        onRoomEvent: (event) => {
          pushes.notify(event).catch(report);
        },
        close: () => pushes.close(),
      };
    },
  });
}

export default pushExtension();

function routes(pushes: Pushes): ExtensionRoute[] {
  const refused = async (work: () => Promise<boolean>, missing: string) => {
    try {
      return (await work()) ? new Response(null, { status: 204 }) : problem(404, missing);
    } catch (error) {
      if (error instanceof BadSubscription) return problem(400, error.message);
      throw error;
    }
  };
  return [
    {
      method: "GET",
      path: "/web",
      auth: "player",
      handle: () => Response.json({ publicKey: pushes.publicKey } satisfies PushKeyResponse),
    },
    {
      method: "POST",
      path: "/web",
      auth: "player",
      handle: async (request, { player, clientId }) => {
        const body = await readBody(request, PushSubscribeRequest);
        if (body instanceof Response) return body;
        return refused(async () => {
          await pushes.subscribe(player!.id, clientId!, body);
          return true;
        }, "");
      },
    },
    {
      method: "DELETE",
      path: "/web",
      auth: "player",
      handle: (request, { player }) => {
        const endpoint = new URL(request.url).searchParams.get("endpoint");
        if (endpoint === null) return problem(400, "Which endpoint? ?endpoint=…");
        return refused(() => pushes.unsubscribe(player!.id, endpoint), "No such subscription");
      },
    },
    {
      // A service worker has no token; the old subscription's auth secret stands in for one.
      method: "POST",
      path: "/web/renew",
      auth: "none",
      handle: async (request) => {
        const body = await readBody(request, PushRenewRequest);
        if (body instanceof Response) return body;
        return refused(() => pushes.renew(body.old, body.subscription), "No such subscription");
      },
    },
    {
      method: "GET",
      path: "/devices",
      auth: "player",
      handle: () => Response.json(pushes.platforms satisfies DevicesResponse),
    },
    {
      method: "POST",
      path: "/devices",
      auth: "player",
      handle: async (request, { player, clientId }) => {
        const body = await readBody(request, DeviceRequest);
        if (body instanceof Response) return body;
        return refused(async () => {
          await pushes.register(player!.id, clientId!, body);
          return true;
        }, "");
      },
    },
    {
      method: "DELETE",
      path: "/devices/:token",
      auth: "player",
      handle: (_request, { player, params }) =>
        refused(() => pushes.unregister(player!.id, params.token!), "No such device"),
    },
  ];
}

/** The keys of assistants kept in memory only, shared by all of them in this process. */
let memoryKeys: VapidKeys | undefined;

/**
 * The server's VAPID keys, made on first start in `push-vapid.json` beside the database.
 * Browsers' subscriptions are bound to them, and a browser has one subscription for the whole
 * site, so every assistant whose database is in that directory shares them.
 */
function vapidKeys(dataDir: string | undefined): VapidKeys {
  if (dataDir === undefined) return (memoryKeys ??= generateVapidKeys());
  // dataDir is <database>.extensions/push.
  const file = join(dirname(dirname(dataDir)), "push-vapid.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as VapidKeys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const keys = generateVapidKeys();
  try {
    writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600, flag: "wx" });
    return keys;
  } catch (error) {
    // Another assistant made them first.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return JSON.parse(readFileSync(file, "utf8")) as VapidKeys;
  }
}

function readSetting(file: string, setting: string): string {
  try {
    return readFileSync(resolve(file), "utf8");
  } catch (error) {
    throw new Error(`push: ${setting}: can't read ${file}: ${(error as Error).message}`);
  }
}

function serviceAccount(file: string): ServiceAccount {
  try {
    return JSON.parse(readSetting(file, "fcm.serviceAccountFile")) as ServiceAccount;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`push: fcm.serviceAccountFile ${file} is not JSON`);
    throw error;
  }
}

async function readBody<S extends TSchema>(
  request: Request,
  schema: S,
): Promise<Static<S> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, "The body is not JSON");
  }
  if (!Value.Check(schema, body)) {
    const first = [...Value.Errors(schema, body)][0];
    return problem(400, `Invalid body: ${first?.instancePath || "/"} ${first?.message ?? ""}`);
  }
  return body as Static<S>;
}

function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
