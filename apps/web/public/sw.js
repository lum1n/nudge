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
    (window) => window.visibilityState === "visible" && new URL(window.url).pathname === message.url,
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
