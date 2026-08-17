import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix as path } from "node:path";
import vm from "node:vm";

import {
  registerServiceWorker,
  SERVICE_WORKER_SCOPE,
  SERVICE_WORKER_URL,
} from "../js/register-service-worker.js";

const ROOT_URL = "https://example.test/TrackMaster/";
const CURRENT_CACHE_NAME = "apex-lap-tracker-20260815-issue22-zero-capture-review-fixes";

async function text(file) {
  return readFile(new URL(`../${file}`, import.meta.url), "utf8");
}

function relativeAsset(specifier, fromFile) {
  const resolved = new URL(specifier, new URL(fromFile, ROOT_URL));
  assert.equal(resolved.origin, new URL(ROOT_URL).origin, `${specifier} must be same-origin`);
  assert.ok(resolved.pathname.startsWith("/TrackMaster/"), `${specifier} must stay in repository scope`);
  const name = resolved.pathname.slice("/TrackMaster/".length);
  return name === "" ? "./" : `./${name}`;
}

function assetAttributes(source) {
  return [...source.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
}

function cssUrls(source) {
  return [...source.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((match) => match[1]);
}

function moduleSpecifiers(source) {
  return [...source.matchAll(/(?:\bimport\s+(?:[^"']+?\s+from\s+)?|\bexport\s+[^"']+?\s+from\s+)["']([^"']+)["']/g)]
    .map((match) => match[1]);
}

function precacheList(source) {
  const block = source.match(/const PRECACHE_URLS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(block, "service worker must expose an explicit precache list");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

async function runtimeAssets() {
  const html = await text("index.html");
  const manifest = JSON.parse(await text("manifest.webmanifest"));
  const assets = new Set(["./", "./index.html"]);
  for (const specifier of assetAttributes(html)) {
    assets.add(relativeAsset(specifier, "index.html"));
  }
  for (const icon of manifest.icons) assets.add(relativeAsset(icon.src, "manifest.webmanifest"));

  const cssFile = "css/app.css";
  for (const specifier of cssUrls(await text(cssFile))) {
    assets.add(relativeAsset(specifier, cssFile));
  }

  const pending = ["js/main.js"];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    assets.add(`./${file}`);
    for (const specifier of moduleSpecifiers(await text(file))) {
      assert.ok(specifier.startsWith("."), `${file} module imports must be relative`);
      const resolved = path.normalize(path.join(path.dirname(file), specifier));
      pending.push(resolved);
    }
  }
  return assets;
}

function parsePng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(buffer.readUInt8(24), 8, "icons use 8-bit channels");
  assert.ok([2, 6].includes(buffer.readUInt8(25)), "icons use RGB or RGBA pixels");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function createServiceWorkerHarness({
  failPath = null,
  failCachePutPath = null,
  staleHttpCache = false,
} = {}) {
  const handlers = new Map();
  const stores = new Map();
  const networkRequests = [];
  const cachePutRequests = [];
  let offline = false;
  let skipWaitingCalls = 0;
  let claimCalls = 0;

  function keyFor(request) {
    return typeof request === "string" ? request : request.url;
  }

  async function network(request) {
    const requestObject = typeof request === "string" ? new Request(request) : request;
    const url = requestObject.url;
    networkRequests.push({ url, cache: requestObject.cache });
    if (offline) throw new TypeError("offline");
    if (failPath && new URL(url).pathname.endsWith(failPath)) {
      return new Response("missing", { status: 404 });
    }
    const source = staleHttpCache && !["reload", "no-store"].includes(requestObject.cache)
      ? "http-cache-old"
      : staleHttpCache
        ? "network-new"
        : "network";
    return new Response(`${source}:${new URL(url).pathname}`, { status: 200 });
  }

  function cacheFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      async put(request, response) {
        const url = keyFor(request);
        cachePutRequests.push({ name, url });
        if (
          failCachePutPath &&
          name === CURRENT_CACHE_NAME &&
          new URL(url).pathname.endsWith(failCachePutPath)
        ) {
          throw new TypeError(`Cache write failed: ${url}`);
        }
        entries.set(url, response.clone());
      },
      async match(request) {
        return entries.get(keyFor(request))?.clone();
      },
    };
  }

  const caches = {
    async open(name) {
      return cacheFor(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  const self = {
    registration: { scope: ROOT_URL },
    clients: {
      async claim() {
        claimCalls += 1;
      },
    },
    async skipWaiting() {
      skipWaitingCalls += 1;
    },
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
  };
  const context = { self, caches, fetch: network, Request, URL, Response, console };

  async function lifecycle(type) {
    let promise;
    handlers.get(type)({ waitUntil(value) { promise = value; } });
    assert.ok(promise, `${type} must use waitUntil`);
    return promise;
  }

  async function request(request) {
    let promise;
    handlers.get("fetch")({ request, respondWith(value) { promise = value; } });
    return promise ? promise : undefined;
  }

  return {
    evaluate: async (source) => vm.runInNewContext(source, context, { filename: "sw.js" }),
    lifecycle,
    request,
    stores,
    caches,
    networkRequests,
    cachePutRequests,
    setOffline(value) { offline = value; },
    get skipWaitingCalls() { return skipWaitingCalls; },
    get claimCalls() { return claimCalls; },
  };
}

test("manifest and iOS metadata provide a relative standalone installation", async () => {
  const manifest = JSON.parse(await text("manifest.webmanifest"));
  const html = await text("index.html");
  assert.equal(manifest.id, "./");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#08090a");
  assert.deepEqual(manifest.icons.map(({ sizes }) => sizes), ["192x192", "512x512"]);
  assert.ok(manifest.icons.every(({ src, type, purpose }) =>
    src.startsWith("./icons/") && type === "image/png" && purpose.includes("maskable")));
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.match(html, /apple-touch-icon" sizes="180x180" href="\.\/icons\/icon-180\.png"/);
});

test("all declared icons are valid square PNG files at their advertised dimensions", async () => {
  const manifest = JSON.parse(await text("manifest.webmanifest"));
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\.\//, "");
    const dimensions = parsePng(await readFile(new URL(`../${file}`, import.meta.url)));
    const [width, height] = icon.sizes.split("x").map(Number);
    assert.deepEqual(dimensions, { width, height });
  }
  assert.deepEqual(parsePng(await readFile(new URL("../icons/icon-180.png", import.meta.url))), {
    width: 180,
    height: 180,
  });
});

test("runtime assets are local and the explicit cache manifest is complete", async () => {
  const html = await text("index.html");
  const css = await text("css/app.css");
  for (const specifier of assetAttributes(html)) {
    assert.ok(!/^https?:/i.test(specifier), `remote HTML asset: ${specifier}`);
  }
  for (const specifier of cssUrls(css)) {
    assert.ok(!/^https?:/i.test(specifier), `remote CSS asset: ${specifier}`);
  }
  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/i);
  assert.match(css, /\.\.\/fonts\/rajdhani-500-latin\.woff2/);
  assert.match(css, /\.\.\/fonts\/space-mono-700-latin\.woff2/);

  const sw = await text("sw.js");
  const cached = new Set(precacheList(sw));
  assert.deepEqual([...cached].sort(), [...await runtimeAssets()].sort());
  assert.ok(!cached.has("./sw.js"), "the browser, not the app cache, owns service-worker updates");
  assert.ok([...cached].every((file) => !file.startsWith("./test/") && !file.includes("raw-sensors.json")));
  for (const file of cached) {
    const localFile = file === "./" ? "index.html" : file.replace(/^\.\//, "");
    assert.ok((await readFile(new URL(`../${localFile}`, import.meta.url))).byteLength > 0, `${file} exists`);
  }
});

test("registration keeps script and scope relative beneath /TrackMaster and forces update checks", async () => {
  const calls = [];
  let updates = 0;
  const navigatorRef = {
    serviceWorker: {
      async register(url, options) {
        calls.push({ url, options });
        return { async update() { updates += 1; } };
      },
    },
  };
  await registerServiceWorker(navigatorRef);
  assert.equal(SERVICE_WORKER_URL, "./sw.js");
  assert.equal(SERVICE_WORKER_SCOPE, "./");
  assert.deepEqual(calls, [{
    url: "./sw.js",
    options: { scope: "./", updateViaCache: "none" },
  }]);
  assert.equal(new URL(calls[0].url, ROOT_URL).pathname, "/TrackMaster/sw.js");
  assert.equal(new URL(calls[0].options.scope, ROOT_URL).pathname, "/TrackMaster/");
  assert.equal(updates, 1);
});

test("service worker uses a build stamp and serves cold cached navigation and assets", async () => {
  const source = await text("sw.js");
  assert.match(source, /const BUILD_STAMP = "\d{8}-issue\d+(?:-[a-z0-9-]+)?";/);
  assert.match(source, /const CACHE_NAME = `\$\{CACHE_PREFIX\}\$\{BUILD_STAMP\}`;/);

  const harness = createServiceWorkerHarness();
  await harness.evaluate(source);
  await harness.lifecycle("install");
  assert.equal(harness.skipWaitingCalls, 1);
  harness.setOffline(true);

  const navigation = await harness.request({
    method: "GET",
    mode: "navigate",
    url: `${ROOT_URL}?dev-recorder=1`,
  });
  assert.equal(await navigation.text(), "network:/TrackMaster/index.html");
  const asset = await harness.request({
    method: "GET",
    mode: "same-origin",
    url: `${ROOT_URL}css/app.css`,
  });
  assert.equal(await asset.text(), "network:/TrackMaster/css/app.css");
});

test("precache bypasses stale HTTP entries and stores fresh bytes under canonical keys", async () => {
  const source = await text("sw.js");
  const harness = createServiceWorkerHarness({ staleHttpCache: true });
  await harness.evaluate(source);
  await harness.lifecycle("install");

  assert.equal(harness.networkRequests.length, precacheList(source).length);
  assert.ok(
    harness.networkRequests.every(({ url, cache }) =>
      url.startsWith(ROOT_URL) && !url.includes("?") && cache === "reload"),
    "every canonical scoped precache request bypasses the browser HTTP cache",
  );

  const freshCache = harness.stores.get(CURRENT_CACHE_NAME);
  assert.ok(freshCache, "the fresh stamped cache exists after a complete install");
  assert.ok([...freshCache.keys()].every((url) => url.startsWith(ROOT_URL) && !url.includes("?")));
  assert.equal(
    await (await freshCache.get(`${ROOT_URL}css/app.css`).clone()).text(),
    "network-new:/TrackMaster/css/app.css",
  );

  harness.setOffline(true);
  const cachedAsset = await harness.request({
    method: "GET",
    mode: "same-origin",
    url: `${ROOT_URL}css/app.css`,
  });
  assert.equal(await cachedAsset.text(), "network-new:/TrackMaster/css/app.css");
});

test("activation removes only stale Apex builds and claims existing installs", async () => {
  const source = await text("sw.js");
  const harness = createServiceWorkerHarness();
  await harness.evaluate(source);
  await harness.caches.open("apex-lap-tracker-20260731-old");
  await harness.caches.open("other-application-cache");
  await harness.lifecycle("install");
  await harness.lifecycle("activate");

  const names = await harness.caches.keys();
  assert.ok(names.includes(CURRENT_CACHE_NAME));
  assert.ok(!names.includes("apex-lap-tracker-20260731-old"));
  assert.ok(names.includes("other-application-cache"));
  assert.equal(harness.claimCalls, 1);
});

test("a failed fresh precache leaves the prior complete build usable", async () => {
  const oldCacheName = "apex-lap-tracker-20260731-old";
  const harness = createServiceWorkerHarness({ failPath: "icons/icon-512.png" });
  const oldCache = await harness.caches.open(oldCacheName);
  await oldCache.put(`${ROOT_URL}index.html`, new Response("old-complete-build"));

  await harness.evaluate(await text("sw.js"));
  await assert.rejects(harness.lifecycle("install"), /Precache failed/);

  assert.equal(harness.skipWaitingCalls, 0);
  assert.equal(harness.claimCalls, 0);
  assert.ok((await harness.caches.keys()).includes(oldCacheName));
  assert.ok(!(await harness.caches.keys()).includes(CURRENT_CACHE_NAME));
  assert.equal(
    await (await oldCache.match(`${ROOT_URL}index.html`)).text(),
    "old-complete-build",
  );
});

test("a failed precache cache write rolls back the incomplete build and preserves the prior cache", async () => {
  const oldCacheName = "apex-lap-tracker-20260731-old";
  const harness = createServiceWorkerHarness({ failCachePutPath: "icons/icon-512.png" });
  const oldCache = await harness.caches.open(oldCacheName);
  await oldCache.put(`${ROOT_URL}index.html`, new Response("old-complete-build"));

  await harness.evaluate(await text("sw.js"));
  await assert.rejects(harness.lifecycle("install"), /Cache write failed/);

  const currentWrites = harness.cachePutRequests.filter(({ name }) => name === CURRENT_CACHE_NAME);
  assert.ok(currentWrites.length > 1, "the failed write follows earlier successful cache writes");
  assert.ok(currentWrites.some(({ url }) => url.endsWith("icons/icon-512.png")));
  assert.equal(harness.skipWaitingCalls, 0);
  assert.ok((await harness.caches.keys()).includes(oldCacheName));
  assert.ok(!(await harness.caches.keys()).includes(CURRENT_CACHE_NAME));
  assert.equal(
    await (await oldCache.match(`${ROOT_URL}index.html`)).text(),
    "old-complete-build",
  );
});

test("fetch ignores non-GET, cross-origin, and out-of-scope requests and never runtime-caches misses", async () => {
  const harness = createServiceWorkerHarness();
  await harness.evaluate(await text("sw.js"));
  await harness.lifecycle("install");
  const networkCount = harness.networkRequests.length;

  assert.equal(await harness.request({ method: "POST", mode: "same-origin", url: ROOT_URL }), undefined);
  assert.equal(await harness.request({ method: "GET", mode: "cors", url: "https://cdn.test/file.js" }), undefined);
  assert.equal(await harness.request({
    method: "GET",
    mode: "same-origin",
    url: "https://example.test/other/file.js",
  }), undefined);
  assert.equal(harness.networkRequests.length, networkCount);

  const replayUrl = `${ROOT_URL}trackmaster-raw-sensors.json`;
  const response = await harness.request({ method: "GET", mode: "same-origin", url: replayUrl });
  assert.equal(await response.text(), "network:/TrackMaster/trackmaster-raw-sensors.json");
  harness.setOffline(true);
  await assert.rejects(
    harness.request({ method: "GET", mode: "same-origin", url: replayUrl }),
    /offline/,
  );
});

test("README contains deployment, install, recovery, offline, recorder, replay, and track validation gates", async () => {
  const readme = await text("README.md");
  for (const required of [
    "Settings → Pages",
    "Share → Add to Home Screen → Add",
    "Motion & Orientation Access",
    "Privacy & Security → Location Services",
    "Airplane Mode",
    "cold launch",
    "?dev-recorder=1",
    "trackmaster-raw-sensors.json",
    "?dev-sensors=replay",
    "Lean decays materially toward `0°`",
    "Hard upright acceleration or braking produces a large false lean spike",
    "Automation cannot enable GitHub Pages",
    "physical-iPhone check is required",
  ]) {
    assert.ok(readme.includes(required), `README missing: ${required}`);
  }
  assert.match(readme, /- \[ \] Save the automatic raw recorder log first/);
  assert.match(readme, /Do not diagnose the display while riding/);
  assert.match(readme, /does not use localStorage, IndexedDB, a database, or a server/);
});
