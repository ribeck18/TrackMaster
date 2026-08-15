import test from "node:test";
import assert from "node:assert/strict";

import { captureBikeFrame } from "../js/core/bike-frame.js";
import {
  angleDeltaDegrees,
  createForwardAxisRefiner,
  wrapDegrees,
} from "../js/core/forward-axis-refiner.js";
import { createGpsSpeedometer } from "../js/core/gps-speed.js";
import { createLeanEstimator } from "../js/core/lean-estimator.js";
import {
  createSyntheticSessionSamples,
  SYNTHETIC_SCENARIOS,
} from "../js/dev/simulator.js";

const G = 9.80665;

function motionAtYaw(yawDegrees, acceleration = 1, verticalYawRateDps = 0, extras = {}) {
  const radians = (yawDegrees * Math.PI) / 180;
  return {
    type: "motion",
    accelerationIncludingGravity: {
      x: Math.sin(radians) * acceleration,
      y: Math.cos(radians) * acceleration,
      z: G,
    },
    rotationRate: { x: 0, y: 0, z: verticalYawRateDps },
    ...extras,
  };
}

function fix(timestamp, speedMps, {
  headingDegrees = 0,
  courseHeadingDegrees = headingDegrees,
  accuracy = 3,
} = {}) {
  return {
    type: "location",
    timestamp: 1_700_000_000_000 + timestamp,
    speedMps,
    evidenceSpeedMps: speedMps,
    headingDegrees,
    courseHeadingDegrees,
    accuracy,
  };
}

function feedInterval(refiner, startMs, {
  startSpeed = 15,
  gpsAcceleration = 1,
  startHeading = 0,
  courseRateDps = 0,
  candidateYaw = 20,
  deviceAcceleration = null,
  lateralInterceptMps2 = 0,
  forwardInterceptMps2 = 0,
  verticalYawRateDps = courseRateDps,
  accuracy = 3,
  intervalMs = 500,
  noiseAt = () => 0,
} = {}) {
  if (startMs === 0) {
    refiner.addLocation(fix(0, startSpeed, { headingDegrees: startHeading, accuracy }), 0);
  }
  const yawRadians = (candidateYaw * Math.PI) / 180;
  const rightAcceleration = gpsAcceleration * Math.sin(yawRadians) + lateralInterceptMps2;
  const forwardAcceleration = gpsAcceleration * Math.cos(yawRadians) + forwardInterceptMps2;
  const intervalDirection = (Math.atan2(rightAcceleration, forwardAcceleration) * 180) / Math.PI;
  const intervalMagnitude = deviceAcceleration ?? Math.hypot(rightAcceleration, forwardAcceleration);
  for (let elapsed = 100; elapsed < intervalMs; elapsed += 100) {
    const receivedAt = startMs + elapsed;
    refiner.addMotion(motionAtYaw(
      intervalDirection + noiseAt(receivedAt),
      intervalMagnitude,
      verticalYawRateDps,
    ), receivedAt);
    refiner.advance(0.1);
  }
  const end = startMs + intervalMs;
  const endSpeed = startSpeed + gpsAcceleration * intervalMs / 1_000;
  const endHeading = startHeading + courseRateDps * intervalMs / 1_000;
  refiner.addLocation(fix(end, endSpeed, {
    headingDegrees: endHeading,
    courseHeadingDegrees: endHeading,
    accuracy,
  }), end);
  refiner.advance(0.1);
  return { end, endSpeed, endHeading };
}

function runIntervals(refiner, count, options = {}) {
  let state = { end: 0, endSpeed: options.startSpeed ?? 15, endHeading: options.startHeading ?? 0 };
  const accelerationPattern = options.gpsAcceleration === undefined
    ? [1, 2.2, 1.4, 2.4]
    : null;
  for (let index = 0; index < count; index += 1) {
    state = feedInterval(refiner, state.end, {
      ...options,
      gpsAcceleration: accelerationPattern?.[index % accelerationPattern.length] ??
        options.gpsAcceleration,
      startSpeed: state.endSpeed,
      startHeading: state.endHeading,
    });
  }
  return state;
}

function runTwistedSession({ refinement = true } = {}) {
  let now = 0;
  const estimator = createLeanEstimator({
    nowRef: () => now,
    stationaryRateThresholdDps: 0.1,
    ...(refinement
      ? {}
      : { forwardRefinementOptions: { minimumSpeedMps: 1_000_000 } }),
  });
  const speedometer = createGpsSpeedometer();
  const readings = [];
  for (const sample of createSyntheticSessionSamples({ mountYawDegrees: 20 })) {
    now = sample.timestamp;
    if (sample.type === "motion" && !estimator.snapshot().calibrated) estimator.calibrate(sample);
    if (sample.type === "location") {
      speedometer.handle(sample);
      estimator.update(speedometer.kinematicSample());
    } else if (sample.type === "motion") {
      readings.push({ timestamp: sample.timestamp, ...estimator.update(sample) });
    }
  }
  return readings;
}

function range(readings, scenario) {
  return readings.filter(({ timestamp }) => timestamp >= scenario.start && timestamp <= scenario.end);
}

function maximumError(readings, scenario) {
  return Math.max(...range(readings, scenario).map(
    ({ leanDegrees }) => Math.abs(leanDegrees - scenario.trueLeanDegrees),
  ));
}

test("angle helpers handle north wrap and reject non-finite values", () => {
  assert.equal(angleDeltaDegrees(1, 359), 2);
  assert.equal(angleDeltaDegrees(359, 1), -2);
  assert.equal(wrapDegrees(721), 1);
  assert.equal(wrapDegrees(Number.NaN), null);
});

test("a multi-interval acceleration fit acquires slope yaw, not lateral intercept", () => {
  const refiner = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  let state = feedInterval(refiner, 0, {
    gpsAcceleration: 1,
    candidateYaw: 20,
    lateralInterceptMps2: 0.2,
  });
  state = feedInterval(refiner, state.end, {
    startSpeed: state.endSpeed,
    startHeading: state.endHeading,
    gpsAcceleration: 2.2,
    candidateYaw: 20,
    lateralInterceptMps2: 0.2,
  });
  assert.equal(refiner.snapshot().hasTarget, false, "two intervals do not establish fit quality");
  feedInterval(refiner, state.end, {
    startSpeed: state.endSpeed,
    startHeading: state.endHeading,
    gpsAcceleration: 1.4,
    candidateYaw: 20,
    lateralInterceptMps2: 0.2,
  });
  const locked = refiner.snapshot();
  assert.equal(locked.hasTarget, true);
  assert.ok(Math.abs(locked.targetCorrectionDegrees - 20) < 0.01);
  assert.ok(locked.accelerationExcitationMps2 >= 1);
  assert.ok(locked.fitResidualMps2 < 1e-9);
  assert.ok(locked.correctionDegrees > 0 && locked.correctionDegrees < 20);
  for (let index = 0; index < 10; index += 1) refiner.advance(0.1);
  assert.ok(Math.abs(refiner.snapshot().correctionDegrees - 20) < 0.1);
});

test("global fitted-slope polarity resolves an inverted acceleration sensor once", () => {
  const refiner = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  let state = { end: 0, endSpeed: 15, endHeading: 0 };
  for (const gpsAcceleration of [1, 2.2, 1.4]) {
    state = feedInterval(refiner, state.end, {
      startSpeed: state.endSpeed,
      startHeading: state.endHeading,
      gpsAcceleration,
      candidateYaw: 20,
      deviceAcceleration: -gpsAcceleration,
    });
  }
  assert.equal(refiner.snapshot().hasTarget, true);
  assert.ok(Math.abs(refiner.snapshot().targetCorrectionDegrees - 20) < 0.01);
});

test("acquisition rejects insufficient excitation and poor linear fit quality", () => {
  const unexcited = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  runIntervals(unexcited, 6, { gpsAcceleration: 1, candidateYaw: 20 });
  assert.equal(unexcited.snapshot().hasTarget, false);
  assert.equal(unexcited.snapshot().accelerationExcitationMps2, null);

  const poorFit = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  let state = { end: 0, endSpeed: 15, endHeading: 0 };
  const accelerations = [1, 2.2, 1.4, 2.4, 1.1, 2.3];
  const intercepts = [0, 0.9, -0.7, 0.8, -0.6, 0.7];
  for (let index = 0; index < accelerations.length; index += 1) {
    state = feedInterval(poorFit, state.end, {
      startSpeed: state.endSpeed,
      startHeading: state.endHeading,
      gpsAcceleration: accelerations[index],
      candidateYaw: 20,
      lateralInterceptMps2: intercepts[index],
    });
  }
  assert.equal(poorFit.snapshot().hasTarget, false);
});

test("the following GPS fix owns evidence, so a 1 Hz accelerate-to-brake transition cannot refine", () => {
  const refiner = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  refiner.addLocation(fix(0, 15), 0);
  for (let time = 100; time < 1_000; time += 100) {
    refiner.addMotion(motionAtYaw(20, 1), time);
  }
  refiner.addLocation(fix(1_000, 16), 1_000);
  assert.equal(refiner.snapshot().pendingIntervals, 1);
  for (let time = 1_100; time < 2_000; time += 100) {
    refiner.addMotion(motionAtYaw(200, 1), time);
  }
  refiner.addLocation(fix(2_000, 15), 2_000);
  assert.equal(refiner.snapshot().hasTarget, false);
  assert.equal(refiner.snapshot().pendingIntervals, 0);
});

test("strict independent gyro/course gates reject 1-3 degree-per-second shallow turns", () => {
  for (const courseRateDps of [1, 2, 3]) {
    const refiner = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
    const speed = 12;
    const longitudinal = 1;
    const lateral = speed * courseRateDps * Math.PI / 180;
    const falseYaw = Math.atan2(lateral, longitudinal) * 180 / Math.PI;
    runIntervals(refiner, 5, {
      startSpeed: speed,
      gpsAcceleration: longitudinal,
      courseRateDps,
      verticalYawRateDps: courseRateDps,
      candidateYaw: falseYaw,
      deviceAcceleration: Math.hypot(longitudinal, lateral),
    });
    assert.equal(refiner.snapshot().hasTarget, false, `${courseRateDps}°/s turn`);
  }
});

test("poor GPS, course inconsistency, braking, and low speed reject their complete brackets", () => {
  const cases = [
    { label: "poor accuracy", options: { accuracy: 30 } },
    { label: "braking", options: { gpsAcceleration: -1, deviceAcceleration: 1 } },
    { label: "low speed", options: { startSpeed: 5 } },
    { label: "acceleration mismatch", options: { gpsAcceleration: 1, deviceAcceleration: 3 } },
  ];
  for (const { label, options } of cases) {
    const refiner = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
    runIntervals(refiner, 4, options);
    assert.equal(refiner.snapshot().hasTarget, false, label);
  }

  const inconsistent = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  inconsistent.addLocation(fix(0, 15, { headingDegrees: 0, courseHeadingDegrees: 20 }), 0);
  for (let time = 100; time < 500; time += 100) inconsistent.addMotion(motionAtYaw(20), time);
  inconsistent.addLocation(fix(500, 15.5, { headingDegrees: 0, courseHeadingDegrees: 20 }), 500);
  assert.equal(inconsistent.snapshot().pendingIntervals, 0);
});

test("correct mounts with 6-10 degree stable lateral intercept and noise stay baseline", () => {
  for (const apparentYaw of [6, 8, 10]) {
    const refiner = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
    runIntervals(refiner, 6, {
      candidateYaw: 0,
      lateralInterceptMps2: Math.tan(apparentYaw * Math.PI / 180),
      noiseAt: (time) => (time / 100) % 2 ? 0.15 : -0.15,
    });
    assert.equal(refiner.snapshot().hasTarget, false, `${apparentYaw}° stable intercept`);
    assert.equal(refiner.snapshot().correctionDegrees, 0);
  }

  const inconsistentNoise = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  runIntervals(inconsistentNoise, 6, {
    candidateYaw: 8,
    noiseAt: (time) => (time / 100) % 2 ? 4 : -4,
  });
  assert.equal(inconsistentNoise.snapshot().hasTarget, false);
});

test("signed fit survives a lateral/forward intercept crossing net forward zero", () => {
  const accelerationPattern = [0.6, 2, 3];
  const correctOptions = {
    candidateYaw: 0,
    lateralInterceptMps2: -0.55,
    forwardInterceptMps2: -0.8,
  };
  const correctMount = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  let state = { end: 0, endSpeed: 15, endHeading: 0 };
  for (const gpsAcceleration of accelerationPattern) {
    state = feedInterval(correctMount, state.end, {
      ...correctOptions,
      startSpeed: state.endSpeed,
      startHeading: state.endHeading,
      gpsAcceleration,
    });
  }
  assert.equal(correctMount.snapshot().hasTarget, false);
  assert.equal(correctMount.snapshot().correctionDegrees, 0);

  const revalidated = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  state = runIntervals(revalidated, 3, { candidateYaw: 20 });
  assert.equal(revalidated.snapshot().hasTarget, true);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (const gpsAcceleration of accelerationPattern) {
      state = feedInterval(revalidated, state.end, {
        ...correctOptions,
        startSpeed: state.endSpeed,
        startHeading: state.endHeading,
        gpsAcceleration,
      });
    }
  }
  assert.equal(revalidated.snapshot().hasTarget, false, "contradictions roll back old target");
  for (let index = 0; index < 12; index += 1) revalidated.advance(0.1);
  assert.ok(Math.abs(revalidated.snapshot().correctionDegrees) < 0.1);
  assert.equal(revalidated.snapshot().hasTarget, false, "signed replacement fit stays baseline");
});

test("each alternating contradictory interval decrements active confidence and rolls back", () => {
  const refiner = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  let state = runIntervals(refiner, 3, { candidateYaw: 20 });
  assert.equal(refiner.snapshot().confidence, 2);
  for (const candidateYaw of [0, 3]) {
    state = feedInterval(refiner, state.end, {
      startSpeed: state.endSpeed,
      startHeading: state.endHeading,
      gpsAcceleration: 1.8,
      candidateYaw,
    });
  }
  assert.equal(refiner.snapshot().hasTarget, false);
  const beforeRollback = refiner.snapshot().correctionDegrees;
  refiner.advance(0.1);
  assert.ok(refiner.snapshot().correctionDegrees < beforeRollback);
  for (let index = 0; index < 15; index += 1) refiner.advance(0.1);
  assert.ok(Math.abs(refiner.snapshot().correctionDegrees) < 0.1);
});

test("backward monotonic reception and reordered GPS source times are ignored", () => {
  const refiner = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  refiner.addLocation(fix(1_000, 15), 1_000);
  refiner.addLocation(fix(1_500, 15.5), 900);
  refiner.addLocation(fix(500, 20), 1_100);
  for (let time = 1_000; time <= 1_500; time += 100) refiner.addMotion(motionAtYaw(20), time);
  assert.equal(refiner.snapshot().hasTarget, false);
});

test("production-default speed evidence converges by the simulator first-straight end", () => {
  const speedometer = createGpsSpeedometer();
  const refiner = createForwardAxisRefiner(captureBikeFrame({ x: 0, y: 0, z: G }));
  let atStraightEnd = null;
  for (const sample of createSyntheticSessionSamples({ mountYawDegrees: 20 })) {
    if (sample.timestamp > SYNTHETIC_SCENARIOS.firstStraight.end) break;
    if (sample.type === "location") {
      speedometer.handle(sample);
      refiner.addLocation(speedometer.kinematicSample(), sample.timestamp);
    } else if (sample.type === "motion") {
      refiner.addMotion(sample, sample.timestamp);
      refiner.advance(0.1);
      atStraightEnd = refiner.snapshot();
    }
  }
  assert.equal(atStraightEnd.hasTarget, true);
  assert.ok(Math.abs(atStraightEnd.targetCorrectionDegrees - 20) < 0.1);
  assert.ok(Math.abs(atStraightEnd.correctionDegrees - 20) < 0.25,
    `remaining frame error was ${20 - atStraightEnd.correctionDegrees}°`);
});

test("frame refinement is continuous with lean, pitch rate, and learned cross-axis bias", () => {
  let now = 0;
  const estimator = createLeanEstimator({
    nowRef: () => now,
    stationaryRateThresholdDps: 0.1,
    kinematicTrustStartMps: 1_000_000,
    kinematicTrustFullMps: 2_000_000,
  });
  estimator.calibrate({ x: 0, y: 0, z: G });
  estimator.update({ ...motionAtYaw(0, 0.001), timestamp: 0, rotationRate: { x: 1, y: 0, z: 0 } });
  for (now = 100; now <= 10_000; now += 100) {
    estimator.update({
      type: "motion", timestamp: now,
      accelerationIncludingGravity: { x: 0, y: 0, z: G },
      rotationRate: { x: 1, y: 0, z: 0 },
    });
  }
  now += 100;
  estimator.update({
    type: "motion", timestamp: now,
    accelerationIncludingGravity: { x: 0, y: 0, z: G },
    rotationRate: { x: 1, y: 100, z: 0 },
  });
  const initialLean = estimator.snapshot().leanDegrees;
  assert.ok(initialLean > 9);

  const yaw = 20 * Math.PI / 180;
  const pitchRate = { x: 2 * Math.cos(yaw), y: -2 * Math.sin(yaw), z: 0 };
  const values = [initialLean];
  let speed = 15;
  const accelerationPattern = [1, 2.2, 1.4];
  for (let interval = 0; interval < 3; interval += 1) {
    estimator.update(fix(now, speed));
    for (let step = 1; step <= 4; step += 1) {
      now += 100;
      values.push(estimator.update({
        ...motionAtYaw(20, accelerationPattern[interval]),
        timestamp: now,
        rotationRate: { x: 1 + pitchRate.x, y: pitchRate.y, z: 0 },
      }).leanDegrees);
    }
    now += 100;
    speed += accelerationPattern[interval] * 0.5;
    estimator.update(fix(now, speed));
  }
  const deltas = values.slice(1).map((value, index) => Math.abs(value - values[index]));
  assert.ok(Math.max(...deltas) < 0.25, `largest display update was ${Math.max(...deltas)}°`);

  estimator.clearLocation();
  const beforeGap = estimator.snapshot().leanDegrees;
  for (let step = 0; step < 100; step += 1) {
    now += 100;
    estimator.update({
      type: "motion", timestamp: now,
      accelerationIncludingGravity: { x: 0, y: 3, z: G },
      rotationRate: { x: 1, y: 0, z: 0 },
    });
  }
  assert.ok(Math.abs(estimator.snapshot().leanDegrees - beforeGap) < 0.2,
    "device-frame bias remains cancelled after frame rotation and GPS loss");
});

test("assumed frame is immediately usable before any refinement evidence", () => {
  const estimator = createLeanEstimator({ stationaryRateThresholdDps: 0.1 });
  estimator.calibrate({ x: 0, y: 0, z: G });
  estimator.update({
    type: "motion", timestamp: 0,
    accelerationIncludingGravity: { x: 0, y: 0, z: G },
    rotationRate: { x: 0, y: 0, z: 0 },
  });
  const reading = estimator.update({
    type: "motion", timestamp: 100,
    accelerationIncludingGravity: { x: 0, y: 0, z: G },
    rotationRate: { x: 0, y: 100, z: 0 },
  });
  assert.ok(Math.abs(reading.leanDegrees - 10) < 1e-9);
});

test("yaw-twisted production session beats baseline and upright braking stays level", () => {
  const refined = runTwistedSession();
  const baseline = runTwistedSession({ refinement: false });
  const firstCorner = SYNTHETIC_SCENARIOS.sustainedCorner;
  const refinedFirstError = maximumError(refined, firstCorner);
  assert.ok(refinedFirstError < 3, `first-corner error was ${refinedFirstError}°`);
  assert.ok(refinedFirstError <= maximumError(baseline, firstCorner));

  const oppositeCorner = SYNTHETIC_SCENARIOS.sustainedOppositeCorner;
  assert.ok(maximumError(refined, oppositeCorner) <= maximumError(baseline, oppositeCorner));
  const settledOpposite = { ...oppositeCorner, start: oppositeCorner.start + 2_500 };
  assert.ok(maximumError(refined, settledOpposite) < 3,
    "refinement remains accurate after production GPS smoothing settles");

  const brakingLean = range(refined, SYNTHETIC_SCENARIOS.uprightHardBraking)
    .map(({ leanDegrees }) => Math.abs(leanDegrees));
  assert.ok(Math.max(...brakingLean) < 1, `upright braking reached ${Math.max(...brakingLean)}°`);
});
