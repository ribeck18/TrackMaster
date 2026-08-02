import test from "node:test";
import assert from "node:assert/strict";

import { createRaceWakeLock } from "../js/sensors/wake-lock.js";

function fakeDocument() {
  const listeners = new Map();
  return {
    visibilityState: "visible",
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type) { listeners.get(type)?.(); },
    has(type) { return listeners.has(type); },
  };
}

function fakeSentinel() {
  const listeners = new Map();
  return {
    releases: 0,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    async release() {
      this.releases += 1;
      listeners.get("release")?.({ currentTarget: this });
    },
    systemRelease() { listeners.get("release")?.({ currentTarget: this }); },
  };
}

test("race wake lock acquires, re-acquires on visible restore, and releases at end", async () => {
  const documentRef = fakeDocument();
  const sentinels = [fakeSentinel(), fakeSentinel()];
  const requests = [];
  const navigatorRef = {
    wakeLock: {
      async request(kind) {
        requests.push(kind);
        return sentinels[requests.length - 1];
      },
    },
  };
  const wakeLock = createRaceWakeLock({ navigatorRef, documentRef });

  await wakeLock.start();
  assert.deepEqual(requests, ["screen"]);
  documentRef.visibilityState = "hidden";
  sentinels[0].systemRelease();
  documentRef.visibilityState = "visible";
  documentRef.dispatch("visibilitychange");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ["screen", "screen"]);

  await wakeLock.stop();
  assert.equal(sentinels[1].releases, 1);
  assert.equal(wakeLock.isActive(), false);
});

test("a lock that resolves after the race ends is immediately released", async () => {
  const documentRef = fakeDocument();
  const sentinel = fakeSentinel();
  let resolveRequest;
  const navigatorRef = {
    wakeLock: { request: () => new Promise((resolve) => { resolveRequest = resolve; }) },
  };
  const wakeLock = createRaceWakeLock({ navigatorRef, documentRef });

  const starting = wakeLock.start();
  await Promise.resolve();
  const stopping = wakeLock.stop();
  resolveRequest(sentinel);
  await Promise.all([starting, stopping]);
  assert.equal(sentinel.releases, 1);
});

test("END then NEW RUN and START cannot let the old stop release the restarted race lock", async () => {
  const documentRef = fakeDocument();
  const sentinel = fakeSentinel();
  let resolveRequest;
  let requestCount = 0;
  const navigatorRef = {
    wakeLock: {
      request() {
        requestCount += 1;
        return new Promise((resolve) => { resolveRequest = resolve; });
      },
    },
  };
  const wakeLock = createRaceWakeLock({ navigatorRef, documentRef });

  const firstStart = wakeLock.start();
  await Promise.resolve();
  const firstStop = wakeLock.stop();
  const restarted = wakeLock.start();
  resolveRequest(sentinel);
  await Promise.all([firstStart, firstStop, restarted]);

  assert.equal(requestCount, 1, "the pending platform request is adopted by the restarted race");
  assert.equal(sentinel.releases, 0, "the previous race stop does not release the restarted race lock");
  assert.equal(wakeLock.isActive(), true);

  await wakeLock.stop();
  assert.equal(sentinel.releases, 1);
});

test("END then START retries when the inherited pending request rejects", async () => {
  const documentRef = fakeDocument();
  const requests = [];
  const sentinel = fakeSentinel();
  const navigatorRef = {
    wakeLock: {
      request() {
        return new Promise((resolve, reject) => requests.push({ resolve, reject }));
      },
    },
  };
  const wakeLock = createRaceWakeLock({ navigatorRef, documentRef });

  const firstStart = wakeLock.start();
  await Promise.resolve();
  const firstStop = wakeLock.stop();
  const restarted = wakeLock.start();
  requests[0].reject(new Error("request one dropped"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 2, "the restarted race retries after inherited rejection");
  requests[1].resolve(sentinel);
  await Promise.all([firstStart, firstStop, restarted]);
  assert.equal(sentinel.releases, 0);
  assert.equal(wakeLock.isActive(), true);

  await wakeLock.stop();
  assert.equal(sentinel.releases, 1);
});

test("unsupported wake lock is a non-fatal no-op and destroy removes visibility work", async () => {
  const documentRef = fakeDocument();
  const wakeLock = createRaceWakeLock({ navigatorRef: {}, documentRef });
  await wakeLock.start();
  assert.equal(wakeLock.isActive(), true);
  await wakeLock.destroy();
  assert.equal(wakeLock.isActive(), false);
  assert.equal(documentRef.has("visibilitychange"), false);
});
