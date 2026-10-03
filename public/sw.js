/*
 * Forge service worker — device notifications only (no offline caching, no fetch handling).
 *
 * push: shows the notification the server sent (title, short text, deep link). The notification
 *   id is the tag, so a retried delivery replaces the shown notification instead of adding one.
 *   When a Forge tab is open and focused, the tab's inbox already updates live, so no extra
 *   operating-system notification is shown.
 * notificationclick: focuses an open Forge tab (or opens one) at the notification's link. The
 *   page itself checks sign-in and access before showing anything.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function focusedWindow() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.find((w) => w.focused && w.visibilityState === "visible") || null;
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Forge", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      if (!data.test && (await focusedWindow())) return;
      await self.registration.showNotification(data.title || "Forge", {
        body: data.body || "",
        tag: data.tag || undefined,
        renotify: false,
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
        data: { url: typeof data.url === "string" ? data.url : "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  // Only ever open this site.
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).origin === target.origin);
      if (existing) {
        await existing.focus();
        // The page navigates itself (keeps its state and signed-in session).
        existing.postMessage({ type: "forge:navigate", url: target.pathname + target.search });
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

// The browser replaced the subscription (keys rotated or expired): register the new one for the
// signed-in person. Without a session the server refuses, and the device simply stops receiving.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const options = event.oldSubscription && event.oldSubscription.options;
      if (!options || !options.applicationServerKey) return;
      const subscription = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey }));
      const json = subscription.toJSON();
      await fetch("/api/rpc/push.subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }),
      }).catch(() => {});
    })(),
  );
});
