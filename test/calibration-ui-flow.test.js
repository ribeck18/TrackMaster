import test from "node:test";
import assert from "node:assert/strict";

function element() {
  const listeners = new Map();
  return {
    dataset: {},
    classList: { toggle() {} },
    hidden: false,
    disabled: false,
    textContent: "",
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    async click() {
      await Promise.all([...listeners.get("click") ?? []].map((listener) => listener({
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {},
      })));
    },
    setAttribute(name, value) {
      this[name] = String(value);
    },
    focus() {},
    replaceChildren() {},
    append() {},
  };
}

function installUiHarness({ motionPermission = false, pendingLocation = false } = {}) {
  const elements = new Map();
  const readouts = { motion: [element()], location: [element()] };
  const screens = ["enable", "cal", "ready", "race", "report", "permission-denied"].map((state) => {
    const screen = element();
    screen.dataset.screen = state;
    screen.querySelector = () => element();
    return screen;
  });
  const screenByState = new Map(screens.map((screen) => [screen.dataset.screen, screen]));
  const make = (selector) => {
    const next = element();
    elements.set(selector, next);
    return next;
  };

  for (const selector of [
    '[data-action="enable"]', '[data-action="zero"]', '[data-action="start-race"]',
    '[data-action="complete-lap"]', '[data-action="end-race"]', '[data-action="new-run"]',
    '[data-action="save-run"]', '[data-action="retry-raw-export"]', '[data-action="continue-limited"]',
    "[data-speed-value]", "[data-gps-warning]", "[data-race-speed-value]", "[data-race-gps-warning]",
    "[data-wake-lock-status]", "[data-race-time]", "[data-lap-number]", "[data-last-lap]",
    '[data-screen="report"]', "[data-save-status]", "[data-raw-export-status]",
    "[data-calibration-status]", "[data-recovery-guidance]",
    '[data-permission="motion"]', '[data-permission="location"]',
    '[data-result="motion"]', '[data-result="location"]',
  ]) make(selector);

  function gaugeRoot() {
    const root = element();
    const children = new Map([
      [".gauge-active", element()], [".gauge-needle", element()], [".lean-value", element()],
      [".lean-direction", element()], [".lean-gauge desc", element()],
    ]);
    root.querySelector = (selector) => children.get(selector) ?? null;
    return root;
  }
  elements.set("[data-lean-instrument]", gaugeRoot());
  elements.set("[data-race-lean-instrument]", gaugeRoot());

  const windowListeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  let now = 0;
  let resolveMotionPermission;
  let locationSuccess;
  const windowRef = {
    location: { search: "" },
    DeviceMotionEvent: motionPermission
      ? { requestPermission: () => new Promise((resolve) => { resolveMotionPermission = resolve; }) }
      : {},
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      return nextTimer++;
    },
    clearInterval() {},
    confirm: () => true,
  };
  const navigatorRef = {
    geolocation: {
      watchPosition(success) {
        locationSuccess = success;
        if (!pendingLocation) locationSuccess({
          timestamp: 0,
          coords: { latitude: 37, longitude: -122, accuracy: 3, speed: 0, heading: 0 },
        });
        return 1;
      },
      clearWatch() {},
    },
  };
  const documentRef = {
    visibilityState: "visible",
    querySelector: (selector) => elements.get(selector) ?? null,
    querySelectorAll(selector) {
      if (selector === "[data-screen]") return screens;
      const readout = selector.match(/^\[data-readout="(motion|location)"\]$/)?.[1];
      return readout ? readouts[readout] : [];
    },
    createElement: () => element(),
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    elements,
    screens: screenByState,
    windowRef,
    navigatorRef,
    documentRef,
    setNow(value) { now = value; },
    now: () => now,
    emitMotion(event) { windowListeners.get("devicemotion")(event); },
    resolveMotionPermission(permission) { resolveMotionPermission(permission); },
    succeedLocation() {
      locationSuccess({
        timestamp: 0,
        coords: { latitude: 37, longitude: -122, accuracy: 3, speed: 0, heading: 0 },
      });
    },
    runTimeouts() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function replaceGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

test("the Calibrate UI retries a deadline-cancelled capture and reaches Ready", async (t) => {
  const harness = installUiHarness();
  const restore = [
    replaceGlobal("window", harness.windowRef),
    replaceGlobal("navigator", harness.navigatorRef),
    replaceGlobal("document", harness.documentRef),
    replaceGlobal("performance", { now: harness.now }),
  ];
  t.after(() => restore.reverse().forEach((restoreGlobal) => restoreGlobal()));

  await import(`../js/main.js?calibration-ui-flow=${Date.now()}`);
  await harness.elements.get('[data-action="enable"]').click();
  assert.equal(harness.screens.get("cal").hidden, false);

  const zero = harness.elements.get('[data-action="zero"]');
  await zero.click();
  assert.equal(zero.disabled, true);
  assert.equal(zero.textContent, "CAPTURING ZERO");

  harness.setNow(1_001);
  harness.runTimeouts();
  assert.equal(zero.disabled, false);
  assert.equal(zero.textContent, "ZERO NOW");
  assert.equal(
    harness.elements.get("[data-calibration-status]").textContent,
    "ZERO NOT CAPTURED · INSUFFICIENT USABLE MOTION · TRY AGAIN",
  );

  await zero.click();
  for (let index = 0; index <= 10; index += 1) {
    harness.setNow(1_001 + index * 100);
    harness.emitMotion({
      timeStamp: 1_001 + index * 100,
      accelerationIncludingGravity: { x: 0, y: 0, z: 9.80665 },
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },
      interval: 100,
    });
  }

  assert.equal(harness.screens.get("ready").hidden, false);
});

test("a motion grant reaches Calibrate and ZERO while location is pending", async (t) => {
  const harness = installUiHarness({ motionPermission: true, pendingLocation: true });
  const restore = [
    replaceGlobal("window", harness.windowRef),
    replaceGlobal("navigator", harness.navigatorRef),
    replaceGlobal("document", harness.documentRef),
    replaceGlobal("performance", { now: harness.now }),
  ];
  t.after(() => restore.reverse().forEach((restoreGlobal) => restoreGlobal()));

  await import(`../js/main.js?motion-before-location=${Date.now()}`);
  const enabling = harness.elements.get('[data-action="enable"]').click();
  harness.resolveMotionPermission("granted");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.screens.get("cal").hidden, false);
  await harness.elements.get('[data-action="zero"]').click();
  assert.equal(harness.elements.get('[data-action="zero"]').textContent, "CAPTURING ZERO");

  harness.succeedLocation();
  await enabling;
});
