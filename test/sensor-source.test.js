import test from "node:test";
import assert from "node:assert/strict";

import { createAccessOutcomeState } from "../js/access-outcome-state.js";
import {
  createBrowserSensorSource,
  SENSOR_STATUS,
} from "../js/sensors/sensor-source.js";

function location(latitude = 37.1, longitude = -122.2) {
  return {
    timestamp: 1234,
    coords: { latitude, longitude, accuracy: 4, speed: 10, heading: 90 },
  };
}

function harness({ requestPermission, orientationSupported = true, geolocation = true } = {}) {
  const calls = [];
  const listeners = new Map();
  let positionSuccess;
  let positionError;
  let motionResolve;

  const OrientationEvent = orientationSupported ? class DeviceOrientationEvent {} : undefined;
  if (requestPermission === true) {
    OrientationEvent.requestPermission = () => {
      calls.push("motion-request");
      return new Promise((resolve) => {
        motionResolve = resolve;
      });
    };
  }

  const windowRef = {
    DeviceOrientationEvent: OrientationEvent,
    addEventListener(type, listener) {
      calls.push(`listen-${type}`);
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      calls.push(`remove-${type}`);
      listeners.delete(type);
    },
  };

  const navigatorRef = geolocation
    ? {
        geolocation: {
          watchPosition(success, error, options) {
            calls.push("location-watch");
            positionSuccess = success;
            positionError = error;
            assert.deepEqual(options, {
              enableHighAccuracy: true,
              maximumAge: 0,
              timeout: 10_000,
            });
            return 41;
          },
          clearWatch(id) {
            calls.push(`clear-${id}`);
          },
        },
      }
    : {};

  const source = createBrowserSensorSource({
    windowRef,
    navigatorRef,
    setTimeoutRef: () => 9,
    clearTimeoutRef: () => {},
  });

  return {
    source,
    calls,
    listeners,
    resolveMotion: (value) => motionResolve(value),
    succeedLocation: () => positionSuccess(location()),
    failLocation: (code, message = "location error") => positionError({ code, message }),
  };
}

test("iOS motion and location permission requests both start in the calling gesture", async () => {
  const app = harness({ requestPermission: true });
  const samples = [];
  app.source.subscribe((sample) => samples.push(sample));

  const access = app.source.requestAccess();
  assert.deepEqual(app.calls, ["motion-request", "location-watch"]);

  app.resolveMotion("granted");
  app.succeedLocation();
  const outcomes = await access;

  assert.equal(outcomes.motion.status, SENSOR_STATUS.GRANTED);
  assert.equal(outcomes.location.status, SENSOR_STATUS.GRANTED);
  assert.ok(app.calls.includes("listen-deviceorientation"));
  assert.equal(samples[0].type, "location");
  assert.equal(samples[0].speed, 10);
});

test("motion denial and location grant resolve independently", async () => {
  const app = harness({ requestPermission: true });
  const access = app.source.requestAccess();

  app.resolveMotion("denied");
  app.succeedLocation();

  assert.deepEqual(await access, {
    motion: { status: SENSOR_STATUS.DENIED, reason: "Motion permission was denied." },
    location: { status: SENSOR_STATUS.GRANTED, reason: "" },
  });
  assert.equal(app.calls.includes("listen-deviceorientation"), false);
});

test("location denial and motion grant resolve independently", async () => {
  const app = harness({ requestPermission: true });
  const access = app.source.requestAccess();

  app.resolveMotion("granted");
  app.failLocation(1, "user denied");
  const outcomes = await access;

  assert.equal(outcomes.motion.status, SENSOR_STATUS.GRANTED);
  assert.equal(outcomes.location.status, SENSOR_STATUS.DENIED);
  assert.ok(app.calls.includes("clear-41"));
});

test("an early location recovery is merged while motion permission is still pending", async () => {
  const app = harness({ requestPermission: true });
  const outcomeState = createAccessOutcomeState();
  app.source.subscribe((sample) => {
    if (sample.type === "access") {
      outcomeState.record(sample.sensor, sample.outcome);
    }
  });

  const access = app.source.requestAccess();
  app.failLocation(2, "temporary GPS failure");
  app.succeedLocation();
  assert.equal(outcomeState.getCurrent(), null, "the early recovery is buffered");

  app.resolveMotion("granted");
  const initialOutcomes = await access;
  assert.equal(initialOutcomes.location.status, SENSOR_STATUS.UNAVAILABLE);

  const finalOutcomes = outcomeState.initialize(initialOutcomes);
  assert.equal(finalOutcomes.motion.status, SENSOR_STATUS.GRANTED);
  assert.equal(finalOutcomes.location.status, SENSOR_STATUS.GRANTED);
});

for (const errorCode of [2, 3]) {
  test(`location error code ${errorCode} is transient and a later fix upgrades access`, async () => {
    const app = harness({ requestPermission: true });
    const samples = [];
    app.source.subscribe((sample) => samples.push(sample));
    const access = app.source.requestAccess();

    app.resolveMotion("granted");
    app.failLocation(errorCode, "temporary GPS failure");
    const outcomes = await access;

    assert.equal(outcomes.location.status, SENSOR_STATUS.UNAVAILABLE);
    assert.equal(app.calls.includes("clear-41"), false, "the location watch remains active");

    app.succeedLocation();
    assert.equal(samples.at(-2).type, "location");
    assert.deepEqual(samples.at(-1), {
      type: "access",
      sensor: "location",
      outcome: { status: SENSOR_STATUS.GRANTED, reason: "" },
    });
  });
}

test("a live fix loss emits unavailable and a later fix recovers on the same watch", async () => {
  const app = harness({ requestPermission: true });
  const samples = [];
  app.source.subscribe((sample) => samples.push(sample));
  const access = app.source.requestAccess();

  app.resolveMotion("granted");
  app.succeedLocation();
  await access;

  app.failLocation(2, "GPS signal lost");
  assert.deepEqual(samples.at(-1), {
    type: "access",
    sensor: "location",
    outcome: { status: SENSOR_STATUS.UNAVAILABLE, reason: "GPS signal lost" },
  });
  assert.equal(app.calls.includes("clear-41"), false);

  app.succeedLocation();
  assert.deepEqual(samples.at(-1), {
    type: "access",
    sensor: "location",
    outcome: { status: SENSOR_STATUS.GRANTED, reason: "" },
  });
});

test("first-fix timeout is unavailable, retains the watch, and recovers later", async () => {
  const timers = [];
  const calls = [];
  const samples = [];
  let positionSuccess;
  const source = createBrowserSensorSource({
    windowRef: {},
    navigatorRef: {
      geolocation: {
        watchPosition(success) {
          positionSuccess = success;
          calls.push("watch");
          return 7;
        },
        clearWatch(id) {
          calls.push(`clear-${id}`);
        },
      },
    },
    setTimeoutRef(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeoutRef() {},
  });
  source.subscribe((sample) => samples.push(sample));

  const access = source.requestAccess();
  assert.equal(timers.length, 1);
  timers[0]();
  const outcomes = await access;
  assert.equal(outcomes.location.status, SENSOR_STATUS.UNAVAILABLE);
  assert.deepEqual(calls, ["watch"]);

  positionSuccess(location());
  assert.equal(samples.at(-1).type, "access");
  assert.equal(samples.at(-1).outcome.status, SENSOR_STATUS.GRANTED);
  assert.deepEqual(calls, ["watch"], "recovery uses the original live watch");
});

test("non-iOS motion falls through to direct event subscription", async () => {
  const app = harness({ requestPermission: false, geolocation: false });
  const samples = [];
  app.source.subscribe((sample) => samples.push(sample));

  const outcomes = await app.source.requestAccess();
  assert.equal(outcomes.motion.status, SENSOR_STATUS.GRANTED);
  assert.equal(outcomes.location.status, SENSOR_STATUS.UNSUPPORTED);
  assert.ok(app.calls.includes("listen-deviceorientation"));

  app.listeners.get("deviceorientation")({ beta: 4, gamma: -7, alpha: 20, timeStamp: 99 });
  assert.deepEqual(samples, [
    { type: "orientation", timestamp: 99, beta: 4, gamma: -7, alpha: 20 },
  ]);
});

test("missing sensor APIs resolve unsupported without hanging", async () => {
  const app = harness({ orientationSupported: false, geolocation: false });
  const outcomes = await app.source.requestAccess();

  assert.equal(outcomes.motion.status, SENSOR_STATUS.UNSUPPORTED);
  assert.equal(outcomes.location.status, SENSOR_STATUS.UNSUPPORTED);
});

test("an unusable Geolocation API is unsupported", async () => {
  const source = createBrowserSensorSource({
    windowRef: {},
    navigatorRef: {
      geolocation: {
        watchPosition() {
          throw new Error("broken geolocation implementation");
        },
      },
    },
    setTimeoutRef: () => 1,
    clearTimeoutRef() {},
  });

  const outcomes = await source.requestAccess();
  assert.equal(outcomes.location.status, SENSOR_STATUS.UNSUPPORTED);
});

test("a platform permission promise that never settles has a finite unsupported outcome", async () => {
  const timers = [];
  class DeviceOrientationEvent {}
  DeviceOrientationEvent.requestPermission = () => new Promise(() => {});
  const source = createBrowserSensorSource({
    windowRef: {
      DeviceOrientationEvent,
      addEventListener() {},
      removeEventListener() {},
    },
    navigatorRef: {},
    setTimeoutRef(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeoutRef() {},
  });

  const access = source.requestAccess();
  assert.equal(timers.length, 1);
  timers[0]();
  const outcomes = await access;
  assert.equal(outcomes.motion.status, SENSOR_STATUS.UNSUPPORTED);
  assert.equal(outcomes.location.status, SENSOR_STATUS.UNSUPPORTED);
});

test("destroy before a pending iOS grant prevents late listener attachment", async () => {
  const app = harness({ requestPermission: true, geolocation: false });
  const access = app.source.requestAccess();

  app.source.destroy();
  app.resolveMotion("granted");
  await access;

  assert.equal(app.calls.includes("listen-deviceorientation"), false);
});

test("the unified subscription unsubscribe and destroy clean up platform streams", async () => {
  const app = harness({ requestPermission: false });
  const samples = [];
  const unsubscribe = app.source.subscribe((sample) => samples.push(sample));
  const access = app.source.requestAccess();
  app.succeedLocation();
  await access;

  unsubscribe();
  app.listeners.get("deviceorientation")({ beta: 1, gamma: 1, timeStamp: 1 });
  assert.equal(samples.length, 1, "only the location sample arrived before unsubscribe");

  app.source.destroy();
  assert.ok(app.calls.includes("remove-deviceorientation"));
  assert.ok(app.calls.includes("clear-41"));
});
