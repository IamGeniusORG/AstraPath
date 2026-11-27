/* AstraPath Lightweight App-Shell Service Worker */
const CACHE_NAME = "astrapath-shell-v4";
const PRECACHE_URLS = [
  "/",
  "/static/css/style.css",
  "/static/js/offline_engine.js",
  "/static/js/map.js",
  "/static/img/astrapath-logo.svg",
  "/api/offline-bundle",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (
    url.pathname === "/api/connectivity" ||
    url.pathname === "/api/route-live" ||
    url.pathname === "/api/geocode" ||
    url.pathname === "/api/reverse-geocode" ||
    url.pathname === "/api/route" ||
    url.pathname.startsWith("/api/offline/places") ||
    url.hostname.includes("tile.openstreetmap.org") ||
    url.hostname.includes("arcgisonline.com")
  ) {
    return;
  }

  if (
    req.mode === "navigate" ||
    url.origin === self.location.origin ||
    url.hostname === "unpkg.com"
  ) {
    event.respondWith(
      fetch(req)
        .then((networkResp) => {
          if (networkResp && networkResp.ok) {
            const copy = networkResp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkResp;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("/")))
    );
  }
});
