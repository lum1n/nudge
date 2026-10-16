// Nudge's service worker: shows the pushes the server sends (see packages/server/src/push).
// It caches nothing; the app needs the server anyway.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message;
  try {
    message = event.data?.json();
  } catch {
    return;
  }
  if (message === undefined || typeof message.title !== "string") return;
  event.waitUntil(show(message));
});

async function show(message) {
  // Someone looking at the room already sees it; a notification would only repeat it.
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const watching = windows.some(
    (window) =>
      window.visibilityState === "visible" && new URL(window.url).pathname === message.url,
  );
  if (watching) return;
  await self.registration.showNotification(message.title, {
    body: message.body,
    tag: message.tag,
    renotify: true,
    icon: "/icon-192.png",
    data: { url: message.url },
    requireInteraction: message.kind === "approval",
  });
}

// The browser dropped or replaced the subscription (keys rotated, or it expired). Subscribe again
// with the same server key and tell each assistant, with the old subscription's auth secret in
// place of a token, which the worker doesn't have. Without the old subscription there's nothing
// to prove it with, and the page subscribes again on its next load instead (push.ts).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(renew(event.oldSubscription, event.newSubscription));
});

async function renew(old, current) {
  const auth = old?.toJSON().keys?.auth;
  if (old === null || old === undefined || auth === undefined) return;
  const key = old.options.applicationServerKey;
  const next =
    current ??
    (key === null
      ? null
      : await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        }));
  if (next === null) return;
  const response = await fetch("/v1/a");
  if (!response.ok) return;
  const { assistants } = await response.json();
  const body = JSON.stringify({
    old: { endpoint: old.endpoint, auth },
    subscription: next.toJSON(),
  });
  // Each assistant answers 404 unless one of its players had the old subscription.
  await Promise.all(
    assistants.map(({ name }) =>
      fetch(`/v1/a/${encodeURIComponent(name)}/push/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }).catch(() => undefined),
    ),
  );
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(open(url));
});

async function open(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const same = windows.find((window) => new URL(window.url).pathname === url);
  if (same !== undefined) return same.focus();
  const any = windows[0];
  if (any !== undefined) {
    await any.focus();
    return any.navigate(url);
  }
  return self.clients.openWindow(url);
}
