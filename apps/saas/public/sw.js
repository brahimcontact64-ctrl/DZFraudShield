const SW_VERSION = "2026.07.14.3";
const CACHE_NAME = `dz-fraud-shield-${SW_VERSION}`;
const SYNC_TAG = "dzfs-refresh-notifications";
const OFFLINE_URLS = [
  "/",
  "/dashboard",
  "/dashboard/call-center",
  "/dashboard/orders",
  "/dashboard/network",
  "/dashboard/shipments",
  "/dashboard/shipping-profile",
  "/dashboard/notifications",
  "/offline"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => {
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
          for (const client of clients) {
            client.postMessage({ type: "SW_VERSION_ACTIVE", version: SW_VERSION });
          }
        });
      })
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  // Never intercept API or auth routes.
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") return caches.match("/offline");
        return new Response("Offline", { status: 503 });
      })
  );
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    console.error("[sw] push: failed to parse payload");
    payload = {};
  }

  const title = payload.title ?? "DZ Fraud Shield";
  const body  = payload.body  ?? "New merchant alert";
  const data  = payload.data  ?? {};
  const url   = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/dashboard/notifications";
  const notifType = typeof data.type === "string" ? data.type : "default";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:      "/icon-192.svg",
      badge:     "/icon-192.svg",
      // tag deduplicates: a second push with the same tag replaces the existing
      // notification instead of stacking, keeping the lock-screen clean.
      tag:       `dzfs-${notifType}`,
      renotify:  true,
      data:      { ...data, url },
    })
  );
});

self.addEventListener("sync", (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        client.postMessage({ type: "REFRESH_NOTIFICATIONS" });
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url ?? "/dashboard/notifications";
  const deliveryEventId = event.notification.data?.deliveryEventId;

  // Only navigate to root-relative paths. "//evil.com" is a protocol-relative URL
  // that resolves to an external host — reject it along with absolute URLs.
  const isSafeUrl = typeof targetUrl === "string" && targetUrl.startsWith("/") && !targetUrl.startsWith("//");

  event.waitUntil((async () => {
    if (deliveryEventId) {
      try {
        await fetch("/api/v1/pwa/push/events/click", {
          method:    "POST",
          headers:   { "Content-Type": "application/json" },
          body:      JSON.stringify({ deliveryEventId }),
          keepalive: true,
        });
      } catch {
        // Telemetry is best-effort; don't block navigation.
      }
    }

    const safeTarget = isSafeUrl ? targetUrl : "/dashboard/notifications";

    // Focus an already-open PWA window if one exists, then navigate it.
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of allClients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === self.location.origin) {
        await client.focus();
        await client.navigate(safeTarget);
        return;
      }
    }

    // No open window — open a new one.
    await self.clients.openWindow(safeTarget);
  })());
});
