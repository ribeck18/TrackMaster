import test from "node:test";
import assert from "node:assert/strict";

import {
  createGpsSpeedometer,
  deriveSpeedMetresPerSecond,
  GPS_SPEED_SOURCE,
  METRES_PER_SECOND_TO_MPH,
} from "../js/core/gps-speed.js";
import { createRawSensorLog } from "../js/core/raw-sensor-log.js";
import { createReplaySensorSource } from "../js/dev/replay.js";
import { createSyntheticSensorSource } from "../js/dev/simulator.js";

function fix({ timestamp = 0, latitude = 0, longitude = 0, speed = null } = {}) {
  return { type: "location", timestamp, latitude, longitude, accuracy: 3, speed, heading: null };
}

function metresPerSecond(mph) {
  return mph / METRES_PER_SECOND_TO_MPH;
}

function manualTimers() {
  const queue = [];
  let nextId = 1;
  return {
    setTimeoutRef(callback, delay) {
      queue.push({ id: nextId, callback, delay, cancelled: false });
      return nextId++;
    },
    clearTimeoutRef(id) {
      const entry = queue.find((candidate) => candidate.id === id);
      if (entry) entry.cancelled = true;
    },
    drain() {
      while (queue.length) {
        const entry = queue.shift();
        if (!entry.cancelled) entry.callback();
      }
    },
  };
}

test("platform speed is preferred and converted from metres/second to whole MPH", () => {
  const speedometer = createGpsSpeedometer({ smoothingFactor: 1 });
  speedometer.handle(fix({ timestamp: 0, longitude: 0, speed: 10 }));
  speedometer.handle(fix({ timestamp: 1_000, longitude: 0.01, speed: 10 }));

  assert.deepEqual(speedometer.snapshot(), {
    hasFix: true,
    hasSpeed: true,
    mph: 22,
    source: GPS_SPEED_SOURCE.PLATFORM,
    warning: "",
  });
});

test("stale and non-finite timestamp fixes cannot replace a current platform reading", () => {
  const speedometer = createGpsSpeedometer({ smoothingFactor: 1 });
  speedometer.handle(fix({ timestamp: 1_000, speed: 10 }));
  const current = speedometer.snapshot();

  speedometer.handle(fix({ timestamp: 1_000, speed: 0 }));
  speedometer.handle(fix({ timestamp: 500, speed: 0 }));
  speedometer.handle(fix({ timestamp: Number.NaN, speed: 0 }));
  assert.deepEqual(speedometer.snapshot(), current);

  speedometer.handle(fix({ timestamp: 2_000, speed: 20 }));
  assert.equal(speedometer.snapshot().mph, 45, "newer fixes still update normally");
});

test("missing platform speed is derived from successive timestamped positions", () => {
  const previous = fix({ timestamp: 1_000, longitude: 0 });
  const current = fix({ timestamp: 11_000, longitude: 0.001 });
  const derived = deriveSpeedMetresPerSecond(previous, current);
  assert.ok(Math.abs(derived - 11.1195) < 0.01);

  const speedometer = createGpsSpeedometer({ smoothingFactor: 1 });
  speedometer.handle(previous);
  assert.deepEqual(speedometer.snapshot(), {
    hasFix: true,
    hasSpeed: false,
    mph: null,
    source: null,
    warning: "GPS · SPEED ACQUIRING",
  });
  speedometer.handle(current);
  assert.equal(speedometer.snapshot().mph, 25);
  assert.equal(speedometer.snapshot().source, GPS_SPEED_SOURCE.DERIVED);
});

test("stale fallback fixes cannot poison the next derivation baseline", () => {
  const speedometer = createGpsSpeedometer({ smoothingFactor: 1 });
  speedometer.handle(fix({ timestamp: 1_000, longitude: 0 }));
  speedometer.handle(fix({ timestamp: 500, longitude: 1 }));
  speedometer.handle(fix({ timestamp: 2_000, longitude: 0.0001 }));

  assert.equal(speedometer.snapshot().mph, 25);
  assert.equal(speedometer.snapshot().source, GPS_SPEED_SOURCE.DERIVED);
});

test("NaN and negative platform speeds fall back to valid position derivation", () => {
  const speedometer = createGpsSpeedometer({ smoothingFactor: 1 });
  speedometer.handle(fix({ timestamp: 0, longitude: 0 }));
  speedometer.handle(fix({ timestamp: 1_000, longitude: 0.0001, speed: Number.NaN }));
  assert.equal(speedometer.snapshot().mph, 25);
  assert.equal(speedometer.snapshot().source, GPS_SPEED_SOURCE.DERIVED);

  speedometer.handle(fix({ timestamp: 2_000, longitude: 0.0002, speed: -1 }));
  assert.equal(speedometer.snapshot().mph, 25);
  assert.equal(speedometer.snapshot().source, GPS_SPEED_SOURCE.DERIVED);
});

test("non-positive fallback intervals and invalid coordinates are ignored", () => {
  const start = fix({ timestamp: 1_000, longitude: 0 });
  assert.equal(deriveSpeedMetresPerSecond(start, fix({ timestamp: 1_000, longitude: 1 })), null);
  assert.equal(deriveSpeedMetresPerSecond(start, fix({ timestamp: 500, longitude: 1 })), null);

  const speedometer = createGpsSpeedometer({ smoothingFactor: 1 });
  speedometer.handle(fix({ timestamp: 0, latitude: Number.NaN, speed: 0 }));
  speedometer.handle(fix({ timestamp: 0, longitude: 181, speed: 0 }));
  assert.equal(speedometer.snapshot().hasFix, false);

  speedometer.handle(fix({ timestamp: 1_000, speed: 0 }));
  speedometer.handle(fix({ timestamp: 2_000, latitude: 91, longitude: 1, speed: 100 }));
  assert.equal(speedometer.snapshot().mph, 0);

  speedometer.handle(fix({ timestamp: 3_000, longitude: 0.0002 }));
  assert.equal(speedometer.snapshot().mph, 25, "invalid fixes do not replace the valid baseline");
});

test("no fix is distinct from a fixed, genuinely stopped zero and recovers", () => {
  const speedometer = createGpsSpeedometer();
  assert.equal(speedometer.snapshot().warning, "GPS · NO FIX");
  assert.equal(speedometer.snapshot().mph, null);

  speedometer.handle(fix({ speed: 0 }));
  assert.equal(speedometer.snapshot().mph, 0);
  assert.equal(speedometer.snapshot().warning, "");

  speedometer.handle({
    type: "access",
    sensor: "location",
    outcome: { status: "unavailable", reason: "signal lost" },
  });
  assert.equal(speedometer.snapshot().mph, null);
  assert.equal(speedometer.snapshot().warning, "GPS · NO FIX");

  speedometer.handle(fix({ timestamp: 2_000, speed: metresPerSecond(31) }));
  assert.equal(speedometer.snapshot().mph, 31);
  assert.equal(speedometer.snapshot().warning, "");
});

test("light smoothing and integer hysteresis prevent adjacent-value flicker", () => {
  const speedometer = createGpsSpeedometer();
  const steadyReadings = [50.4, 50.7, 50.2, 50.65, 50.3, 50.6];
  steadyReadings.forEach((mph, index) => {
    speedometer.handle(fix({ timestamp: index * 500, speed: metresPerSecond(mph) }));
  });

  assert.equal(speedometer.snapshot().mph, 50);
  speedometer.handle(fix({ timestamp: 4_000, speed: metresPerSecond(56) }));
  assert.ok(speedometer.snapshot().mph > 50, "a meaningful speed change is not hidden");
});

test("simulator and replay location samples use the same speedometer seam", async () => {
  const simulatorTimers = manualTimers();
  const simulator = createSyntheticSensorSource({
    samples: [
      fix({ timestamp: 0, speed: metresPerSecond(18) }),
      { type: "orientation", timestamp: 100, alpha: 0, beta: 0, gamma: 0 },
    ],
    loop: false,
    ...simulatorTimers,
  });
  const simulatedSpeed = createGpsSpeedometer({ smoothingFactor: 1 });
  simulator.subscribe(simulatedSpeed.handle);
  await simulator.requestAccess();
  simulatorTimers.drain();
  assert.equal(simulatedSpeed.snapshot().mph, 18);

  const replayTimers = manualTimers();
  const replay = createReplaySensorSource(
    createRawSensorLog([
      fix({ timestamp: 0, longitude: 0 }),
      fix({ timestamp: 10_000, longitude: 0.001 }),
    ]),
    replayTimers,
  );
  const replayedSpeed = createGpsSpeedometer({ smoothingFactor: 1 });
  replay.subscribe(replayedSpeed.handle);
  await replay.requestAccess();
  replayTimers.drain();
  assert.equal(replayedSpeed.snapshot().mph, 25);
  assert.equal(replayedSpeed.snapshot().source, GPS_SPEED_SOURCE.DERIVED);
});
