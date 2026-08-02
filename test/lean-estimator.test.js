import test from "node:test";
import assert from "node:assert/strict";

import {
  captureBikeFrame,
  createBikeFrameCalibrationWindow,
  dot,
  magnitude,
} from "../js/core/bike-frame.js";
import { createGpsSpeedometer } from "../js/core/gps-speed.js";
import {
  assertLeanEstimator,
  createLeanEstimator,
  isGyroDeliveryFresh,
  LEAN_ESTIMATOR_INTERFACE,
} from "../js/core/lean-estimator.js";
import {
  createSyntheticSessionSamples,
  SYNTHETIC_SCENARIOS,
} from "../js/dev/simulator.js";
import { leanGaugeGeometry } from "../js/ui/lean-gauge.js";

const G = 9.80665;
const MPH_TO_MPS = 0.44704;

function bodyMotion(timestamp, {
  trueLean = 0,
  rollRate = 0,
  rollBias = 0,
  worldYawRate = 0,
  gravity = { x: 0, y: 0, z: G },
} = {}) {
  const lean = (trueLean * Math.PI) / 180;
  return {
    type: "motion",
    timestamp,
    accelerationIncludingGravity: gravity,
    rotationRate: {
      x: worldYawRate * Math.sin(lean),
      y: rollRate + rollBias,
      z: -worldYawRate * Math.cos(lean),
    },
    interval: 100,
  };
}

function location(timestamp, speedMps) {
  return { type: "location", timestamp, speedMps };
}

function runSyntheticSession() {
  let now = 0;
  const estimator = createLeanEstimator({ nowRef: () => now });
  const speedometer = createGpsSpeedometer({ smoothingFactor: 1 });
  const readings = [];
  for (const sample of createSyntheticSessionSamples()) {
    now = sample.timestamp;
    if (sample.type === "motion" && !estimator.snapshot().calibrated) estimator.calibrate(sample);
    if (sample.type === "location") {
      speedometer.handle(sample);
      estimator.update(speedometer.kinematicSample());
    } else {
      const reading = estimator.update(sample);
      if (sample.type === "motion") readings.push({ timestamp: sample.timestamp, ...reading });
    }
  }
  return readings;
}

function readingsInRange(readings, range) {
  return readings.filter(({ timestamp }) => timestamp >= range.start && timestamp <= range.end);
}

test("gravity calibration captures an orthonormal full bike frame with +Y mount forward", () => {
  const frame = captureBikeFrame({ x: 3, y: -2, z: 8.9 });
  for (const axis of [frame.vertical, frame.forward, frame.right]) {
    assert.ok(Math.abs(magnitude(axis) - 1) < 1e-12);
  }
  assert.ok(Math.abs(dot(frame.vertical, frame.forward)) < 1e-12);
  assert.ok(Math.abs(dot(frame.vertical, frame.right)) < 1e-12);
  assert.ok(Math.abs(dot(frame.forward, frame.right)) < 1e-12);
  assert.ok(frame.forward.y > 0, "issue #5 keeps the documented +Y mount assumption");
});

test("estimator is swappable behind the documented pure-math interface", () => {
  const estimator = createLeanEstimator();
  assert.equal(assertLeanEstimator(estimator), estimator);
  assert.deepEqual(Object.keys(estimator).sort(), [...LEAN_ESTIMATOR_INTERFACE].sort());
  assert.throws(() => assertLeanEstimator({ update() {} }), /must implement calibrate/);
});

test("estimator consumes normalized x/y/z only and reports signed clamped lean", () => {
  const estimator = createLeanEstimator({ stationaryRateThresholdDps: 0.1 });
  estimator.calibrate({ x: 0, y: 0, z: G });
  estimator.update(bodyMotion(0));
  estimator.update(bodyMotion(100, { rollRate: 900 }));
  assert.equal(estimator.snapshot().leanDegrees, 60);
  estimator.update(bodyMotion(200, { rollRate: -1_500 }));
  assert.equal(estimator.snapshot().leanDegrees, -60);
  assert.equal(estimator.snapshot().direction, "LEFT");
  estimator.update({
    type: "motion",
    timestamp: 300,
    accelerationIncludingGravity: { x: 0, y: 0, z: G },
    rotationRate: { alpha: 999, beta: 999, gamma: 999 },
  });
  assert.equal(estimator.snapshot().leanDegrees, -60, "browser-shaped rates are rejected downstream");
});

test("world yaw is recovered from physically rotated leaned body rates", () => {
  let now = 0;
  const estimator = createLeanEstimator({ nowRef: () => now, stationaryRateThresholdDps: 0.1 });
  estimator.calibrate({ x: 0, y: 0, z: G });
  estimator.update(bodyMotion(0));
  estimator.update(bodyMotion(100, { rollRate: 450 }));
  assert.ok(Math.abs(estimator.snapshot().leanDegrees - 45) < 1e-9);
  now = 100;
  estimator.update(location(1_700_000_000_000, 30));
  now = 200;
  const reading = estimator.update(bodyMotion(200, { trueLean: 45, worldYawRate: 20 }));
  const expected = (Math.atan((30 * 20 * Math.PI / 180) / G) * 180) / Math.PI;
  assert.ok(Math.abs(reading.kinematicDegrees - expected) < 1e-9);
});

test("constant corner with changing roll bias needs the kinematic anchor to hold truth", () => {
  let now = 0;
  const estimator = createLeanEstimator({ nowRef: () => now, stationaryRateThresholdDps: 0.1 });
  estimator.calibrate({ x: 0, y: 0, z: G });
  estimator.update(bodyMotion(0));
  const speed = 25;
  const truth = 35;
  const yaw = ((G * Math.tan(truth * Math.PI / 180)) / speed) * 180 / Math.PI;

  for (let step = 1; step <= 10; step += 1) {
    now = step * 100;
    estimator.update(location(10_000 + step, speed));
    estimator.update(bodyMotion(now, {
      trueLean: truth * step / 10,
      rollRate: truth,
      rollBias: 0.35,
      worldYawRate: yaw,
    }));
  }
  const sustained = [];
  for (let step = 11; step <= 160; step += 1) {
    now = step * 100;
    if (step % 5 === 0) estimator.update(location(10_000 + step, speed));
    sustained.push(estimator.update(bodyMotion(now, {
      trueLean: truth,
      rollBias: step < 80 ? 0.35 : 0.7,
      worldYawRate: yaw,
      gravity: { x: 0, y: 0, z: G / Math.cos(truth * Math.PI / 180) },
    })).leanDegrees);
  }
  assert.ok(Math.abs(sustained.at(-1) - truth) < 1.5);
  assert.ok(Math.min(...sustained.slice(-50)) > truth - 2, "corner must not decay upright");
});

test("independent simulator truth holds both sustained corners", () => {
  const readings = runSyntheticSession();
  for (const scenario of [SYNTHETIC_SCENARIOS.sustainedCorner, SYNTHETIC_SCENARIOS.sustainedOppositeCorner]) {
    const errors = readingsInRange(readings, scenario).map(
      ({ leanDegrees }) => Math.abs(leanDegrees - scenario.trueLeanDegrees),
    );
    assert.ok(Math.max(...errors) < 3, `maximum error was ${Math.max(...errors)}°`);
  }
});

test("pitched braking acceleration and body pitch rate do not become lean", () => {
  const vertical = { x: 0.342, y: 0, z: 0.94 };
  const frame = captureBikeFrame(vertical);
  const estimator = createLeanEstimator({ stationaryRateThresholdDps: 0.1 });
  estimator.calibrate(vertical);
  estimator.update(location(1_700_000_000_000, 30));
  estimator.update({
    type: "motion", timestamp: 0,
    accelerationIncludingGravity: { x: vertical.x * G, y: 0, z: vertical.z * G },
    rotationRate: { x: 0, y: 0, z: 0 },
  });
  for (let timestamp = 100; timestamp <= 3_000; timestamp += 100) {
    const pitchRate = timestamp < 1_000 ? 18 : -8;
    estimator.update({
      type: "motion", timestamp,
      accelerationIncludingGravity: { x: vertical.x * G, y: -6, z: vertical.z * G },
      rotationRate: {
        x: frame.right.x * pitchRate,
        y: frame.right.y * pitchRate,
        z: frame.right.z * pitchRate,
      },
    });
  }
  assert.ok(Math.abs(estimator.snapshot().leanDegrees) < 1e-9);
});

test("stationary detection learns changing bias and pulls post-corner offset upright", () => {
  const estimator = createLeanEstimator();
  estimator.calibrate({ x: 0, y: 0, z: G });
  estimator.update(bodyMotion(0));
  estimator.update(bodyMotion(100, { rollRate: 250 }));
  assert.ok(estimator.snapshot().leanDegrees > 20);
  for (let timestamp = 200; timestamp <= 20_000; timestamp += 100) {
    estimator.update(bodyMotion(timestamp, { rollBias: timestamp < 8_000 ? 0.2 : 0.6 }));
  }
  assert.ok(Math.abs(estimator.snapshot().leanDegrees) < 0.5);
});

test("noisy low-speed yaw is ignored without jumps or oscillation", () => {
  let now = 0;
  const estimator = createLeanEstimator({ nowRef: () => now, stationaryRateThresholdDps: 0.1 });
  estimator.calibrate({ x: 0, y: 0, z: G });
  estimator.update(bodyMotion(0));
  const values = [];
  for (let step = 1; step <= 100; step += 1) {
    now = step * 100;
    estimator.update(location(step, 9 * MPH_TO_MPS));
    values.push(estimator.update(bodyMotion(now, {
      rollRate: step % 2 ? 0.5 : -0.5,
      worldYawRate: step % 3 ? 40 : -40,
    })).leanDegrees);
  }
  assert.ok(Math.max(...values.map(Math.abs)) < 0.1);
});

test("location timestamps reject stale/reordered samples and trust expires by reception age", () => {
  let now = 50;
  const estimator = createLeanEstimator({ nowRef: () => now, locationTrustMaximumAgeMs: 1_000 });
  estimator.calibrate({ x: 0, y: 0, z: G });
  estimator.update(location(1_700_000_000_000, 20));
  assert.equal(estimator.snapshot().hasLocation, true, "epoch GPS time is not compared to monotonic time");
  now = 900;
  estimator.update(location(1_699_999_999_999, 40));
  now = 1_051;
  assert.equal(estimator.snapshot().hasLocation, false, "stale sample cannot renew reception age");
  estimator.update(location(1_700_000_000_001, null));
  assert.equal(estimator.snapshot().hasLocation, false, "new null speed clears trust");
  now = 1_100;
  estimator.update(location(1_700_000_000_002, 22));
  assert.equal(estimator.snapshot().hasLocation, true, "newer usable speed recovers trust");
});

test("motion-only remains responsive and silent GPS gaps disable the anchor", () => {
  let now = 0;
  const estimator = createLeanEstimator({ nowRef: () => now, locationTrustMaximumAgeMs: 500, stationaryRateThresholdDps: 0.1 });
  estimator.calibrate({ x: 0, y: 0, z: G });
  estimator.update(bodyMotion(0));
  estimator.update(location(1, 20));
  now = 700;
  const reading = estimator.update(bodyMotion(100, { rollRate: -20, worldYawRate: 20 }));
  assert.equal(reading.hasLocation, false);
  assert.equal(reading.kinematicDegrees, null);
  assert.ok(reading.leanDegrees < 0);
});

test("ZERO window requires recent stable gravity and gyro and averages accepted samples", () => {
  let now = 0;
  const window = createBikeFrameCalibrationWindow({ nowRef: () => now });
  for (let index = 0; index < 7; index += 1) {
    now = index * 100;
    window.add(bodyMotion(index * 100, {
      rollRate: index % 2 ? 0.1 : -0.1,
      gravity: { x: 0.02 * (index % 2), y: 0, z: G },
    }));
  }
  assert.equal(window.snapshot().ready, true);
  assert.ok(window.snapshot().gravity.x > 0 && window.snapshot().gravity.x < 0.02);
  now += 301;
  assert.equal(window.snapshot().ready, false, "old stable samples cannot be zeroed");
  window.add(bodyMotion(800, { rollRate: 8 }));
  assert.equal(window.snapshot().ready, false, "high-rate motion resets stability");
  window.add(bodyMotion(900, { gravity: { x: 0, y: 5, z: G } }));
  assert.equal(window.snapshot().ready, false, "non-gravity acceleration magnitude is rejected");
});

test("gyro delivery watchdog detects outage and recovery using monotonic reception time", () => {
  assert.equal(isGyroDeliveryFresh(null, 10), false);
  assert.equal(isGyroDeliveryFresh(100, 1_000), true);
  assert.equal(isGyroDeliveryFresh(100, 1_101), false);
  assert.equal(isGyroDeliveryFresh(1_200, 1_100), false);
  assert.equal(isGyroDeliveryFresh(1_100, 1_100), true);
});

test("gauge geometry keeps stable arc topology and signed direction", () => {
  for (const angle of [-30, 0, 30]) assert.match(leanGaugeGeometry(angle).activePath, /^M 200 28 A 182 182/);
  assert.equal(leanGaugeGeometry(-30).direction, "LEFT");
  assert.equal(leanGaugeGeometry(30).direction, "RIGHT");
  assert.equal(leanGaugeGeometry(60).gaugeDegrees, 52);
  assert.equal(leanGaugeGeometry(60).numericDegrees, 60);
});
