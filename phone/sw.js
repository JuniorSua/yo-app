// Yo Phone service worker: caches the app shell only. Never touches /api (relay calls always go to the network).
const VERSION = "1.3.1";
const CACHE = `yo-phone-shell-${VERSION}`;
/** The app's own picture cache (app.js PIC_CACHE): kept across updates, it isn't the shell's to clean up. */
const KEEP = new Set([CACHE, "yo-phone-pics"]);
const SHELL = [
  "/",
  "/app.js",
  "/styles.css",
  "/lib/crypto.js",
  "/lib/inbox.js",
  "/lib/markdown.js",
  "/lib/pics.js",
  "/lib/tasks.js",
  "/lib/view.js",
  "/manifest.webmanifest",
  "/fonts/geist-latin-wght-normal.woff2",
  "/fonts/geist-mono-latin-wght-normal.woff2",
  "/icons/logo.svg",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith("yo-phone-") && !KEEP.has(k)).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Pages: network first so updates land, the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Shell files: cached copy right away, refreshed in the background.
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(url.pathname);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(url.pathname, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
