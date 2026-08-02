const CACHE_PREFIX = "apex-lap-tracker-";
const BUILD_STAMP = "20260802-issue3-replay-init";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_STAMP}`;

// Keep this list explicit: a successful install means the complete application
// shell is available. sw.js is intentionally absent because the browser owns
// the service-worker update request and updateViaCache is disabled at registration.
const PRECACHE_URLS = Object.freeze([
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./fonts/rajdhani-500-latin.woff2",
  "./fonts/rajdhani-600-latin.woff2",
  "./fonts/rajdhani-700-latin.woff2",
  "./fonts/space-mono-400-latin.woff2",
  "./fonts/space-mono-700-latin.woff2",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/access-outcome-state.js",
  "./js/core/bike-frame.js",
  "./js/core/forward-axis-refiner.js",
  "./js/core/gps-speed.js",
  "./js/core/json-value.js",
  "./js/core/lap-timing.js",
  "./js/core/lean-estimator.js",
  "./js/core/raw-sensor-log.js",
  "./js/core/recorder.js",
  "./js/core/report.js",
  "./js/core/run-store.js",
  "./js/core/session-recorder.js",
  "./js/core/track-map.js",
  "./js/dev/dev-sensor-source.js",
  "./js/dev/replay.js",
  "./js/dev/simulator.js",
  "./js/main.js",
  "./js/page-lifecycle.js",
  "./js/register-service-worker.js",
  "./js/router.js",
  "./js/sensors/sensor-source.js",
  "./js/sensors/spirit-level.js",
  "./js/sensors/timed-sensor-source.js",
  "./js/sensors/wake-lock.js",
  "./js/ui/lean-gauge.js",
  "./js/ui/run-report.js",
]);

function scopedUrl(relativeUrl) {
  return new URL(relativeUrl, self.registration.scope).href;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS.map(scopedUrl));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);
  if (requestUrl.origin !== scopeUrl.origin || !requestUrl.pathname.startsWith(scopeUrl.pathname)) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (request.mode === "navigate") {
      const appShell = await cache.match(scopedUrl("./index.html"));
      if (appShell) return appShell;
    } else {
      const cached = await cache.match(request);
      if (cached) return cached;
    }

    // Unlisted same-origin files (for example a temporary replay log) remain
    // network-only and are never allowed to grow the application cache.
    return fetch(request);
  })());
});
