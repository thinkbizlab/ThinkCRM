// ThinkCRM Service Worker — shell cache + Background Sync drain
const CACHE_NAME = "thinkcrm-shell-v1";
const SYNC_TAG   = "thinkcrm-offline-queue";

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/boot.js",
  "/manifest.webmanifest"
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  // API requests — network-only; return offline sentinel on failure.
  // Check-in/out are queued by app.js directly — SW does not intercept them.
  if (url.pathname.startsWith("/api/v1/")) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({ offline: true, message: "You are offline." }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    return;
  }

  // Navigation — network-first, fall back to cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Static assets — cache-first.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, copy));
        }
        return res;
      });
    })
  );
});

// ── Background Sync ───────────────────────────────────────────────────────────
// When the browser fires this (connectivity restored), tell open tabs to drain.
// The page does the actual draining using its live JWT — the SW never touches tokens.
self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(notifyClientsTodrain());
  }
});

async function notifyClientsTodrain() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
  clients.forEach(client => client.postMessage({ type: "SW_DRAIN_QUEUE" }));
}

// ── Message handler ───────────────────────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "REGISTER_SYNC") {
    self.registration.sync?.register(SYNC_TAG).catch(() => {});
  }
});
