import { useEffect, useState } from "react";
import { ApiError, clientFor } from "./api.ts";

// Which assistants this browser's push subscription is registered with, by URL name. A browser
// has one subscription per site, shared by every assistant on the server.
const REGISTERED = "nudge.push";

export type PushState = "unsupported" | "blocked" | "unavailable" | "off" | "on";

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Registers the service worker, which shows pushes; once per page load. */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((error: unknown) => console.warn(error));
}

function registered(): string[] {
  try {
    return JSON.parse(localStorage.getItem(REGISTERED) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function setRegistered(assistant: string, on: boolean): void {
  const rest = registered().filter((name) => name !== assistant);
  localStorage.setItem(REGISTERED, JSON.stringify(on ? [...rest, assistant] : rest));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function state(assistant: string): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  try {
    await clientFor(assistant).api.pushKey();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return "unavailable";
    throw error;
  }
  const subscription = await currentSubscription();
  return subscription !== null && registered().includes(assistant) ? "on" : "off";
}

/** Asks for permission, subscribes this browser and tells the assistant where to push. */
async function enable(assistant: string): Promise<void> {
  const { api } = clientFor(assistant);
  const key = fromBase64Url(await api.pushKey());
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error("Notifications are not allowed for this site");
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made for another server key (say, after the server's keys were made anew) won't work.
  if (subscription !== null && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const json = subscription.toJSON();
  await api.subscribePush({
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  });
  setRegistered(assistant, true);
}

/** Tells the assistant to stop; the browser's subscription goes once no assistant uses it. */
async function disable(assistant: string): Promise<void> {
  const subscription = await currentSubscription();
  if (subscription !== null)
    await clientFor(assistant)
      .api.unsubscribePush(subscription.endpoint)
      .catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      });
  setRegistered(assistant, false);
  if (subscription !== null && registered().length === 0) await subscription.unsubscribe();
}

/** Whether this browser gets the assistant's notifications, and a way to change it. */
export function usePush(assistant: string): {
  state: PushState | undefined;
  error: string | undefined;
  busy: boolean;
  toggle(): void;
} {
  const [current, setCurrent] = useState<PushState>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    state(assistant).then(
      (next) => live && setCurrent(next),
      (caught: unknown) => live && setError((caught as Error).message),
    );
    return () => {
      live = false;
    };
  }, [assistant]);
  return {
    state: current,
    error,
    busy,
    toggle: () => {
      if (busy || (current !== "on" && current !== "off")) return;
      setBusy(true);
      setError(undefined);
      (current === "on" ? disable(assistant) : enable(assistant))
        .then(() => state(assistant))
        .then(setCurrent, (caught: unknown) => setError((caught as Error).message))
        .finally(() => setBusy(false));
    },
  };
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (a === null || a.byteLength !== b.length) return false;
  const bytes = new Uint8Array(a);
  return bytes.every((byte, i) => byte === b[i]);
}
