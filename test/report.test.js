import test from "node:test";
import assert from "node:assert/strict";

import { aggregateRunReport } from "../js/core/report.js";

function lap(index, startTime, endTime) {
  return { index, startTime, endTime, duration: endTime - startTime };
}

function timing({ endedAt = 10_000, laps = [] } = {}) {
  return {
    sessionStartTime: 0,
    currentLapStartTime: laps.at(-1)?.endTime ?? 0,
    lapNumber: laps.length + 1,
    laps,
    endedAt,
  };
}

test("empty ended session produces an immutable coherent zero-lap report", () => {
  const report = aggregateRunReport({ timing: timing({ endedAt: 2_500 }), samples: [] });

  assert.equal(report.lapCount, 0);
  assert.equal(report.bestLap, null);
  assert.equal(report.totalDurationMs, 2_500);
  assert.deepEqual(report.stats, {
    maxSpeedMph: null,
    averageSpeedMph: null,
    maxLeanLeftDegrees: null,
    maxLeanRightDegrees: null,
  });
  assert.deepEqual(report.location, { available: false, sampleCount: 0 });
  assert.equal(report.topSpeedPoint, null);
  assert.equal(report.runId, null);
  assert.equal(report.riderId, null);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.stats));
  assert.ok(Object.isFrozen(report.location));
  assert.ok(Object.isFrozen(report.laps));
  assert.ok(Object.isFrozen(report.samples));
});

test("single positioned speed sample has a max but no invented average coverage", () => {
  const report = aggregateRunReport({
    timing: timing({ endedAt: 1_000 }),
    samples: [{
      t: 999,
      timestamp: 500,
      speedMph: 47.5,
      speedValid: true,
      leanDegrees: -31,
      latitude: 10,
      longitude: 20,
    }],
  });

  assert.equal(report.stats.maxSpeedMph, 47.5);
  assert.equal(report.stats.averageSpeedMph, null);
  assert.equal(report.stats.maxLeanLeftDegrees, 31);
  assert.equal(report.stats.maxLeanRightDegrees, 0);
  assert.deepEqual(report.topSpeedPoint.position, { latitude: 10, longitude: 20 });
  assert.equal(report.topSpeedPoint.t, 500, "relative time is normalized from the monotonic clock");
  assert.deepEqual(report.topSpeedPoint.lap, { index: 1, elapsedMs: 500, completed: false });
});

test("single completed lap is present, best, and detached from its timing input", () => {
  const completedLap = lap(1, 0, 4_000);
  const rawTiming = timing({ endedAt: 5_000, laps: [completedLap] });
  const report = aggregateRunReport({ timing: rawTiming, samples: [] });

  assert.equal(report.lapCount, 1);
  assert.deepEqual(report.laps, [{ ...completedLap, isBest: true }]);
  assert.deepEqual(report.bestLap, { index: 1, duration: 4_000 });
  assert.notEqual(report.laps[0], completedLap);
  assert.ok(Object.isFrozen(report.laps[0]));
});

test("multi-lap report includes every completed lap and highlights every tied best", () => {
  const laps = [lap(1, 0, 5_000), lap(2, 5_000, 9_000), lap(3, 9_000, 13_000)];
  const report = aggregateRunReport(
    {
      timing: timing({ endedAt: 15_000, laps }),
      samples: [
        { t: 2_000, timestamp: 2_000, speedMph: 50, speedValid: true, leanDegrees: -20 },
        { t: 7_000, timestamp: 7_000, speedMph: 105, speedValid: true, leanDegrees: 42, latitude: 37.1, longitude: -122.1 },
        { t: 14_000, timestamp: 14_000, speedMph: 80, speedValid: true, leanDegrees: -48 },
      ],
    },
    { runNumber: 3 },
  );

  assert.equal(report.runNumber, 3);
  assert.deepEqual(report.laps.map(({ index, isBest }) => ({ index, isBest })), [
    { index: 1, isBest: false },
    { index: 2, isBest: true },
    { index: 3, isBest: true },
  ]);
  assert.deepEqual(report.bestLap, { index: 2, duration: 4_000 });
  assert.equal(report.stats.maxLeanLeftDegrees, 48);
  assert.equal(report.stats.maxLeanRightDegrees, 42);
  assert.deepEqual(report.topSpeedPoint, {
    speedMph: 105,
    timestamp: 7_000,
    t: 7_000,
    position: { latitude: 37.1, longitude: -122.1 },
    lap: { index: 2, elapsedMs: 2_000, completed: true },
  });
});

test("missing speed, lean, and location values do not contaminate aggregates", () => {
  const report = aggregateRunReport({
    timing: timing({ endedAt: 4_000 }),
    samples: [
      { timestamp: 0, speedMph: null, speedValid: false, leanDegrees: Number.NaN, latitude: 1, longitude: null },
      { timestamp: 1_000, speedMph: 20, speedValid: true, leanDegrees: 0, latitude: null, longitude: 2 },
      { timestamp: 2_000, speedMph: null, speedValid: false, leanDegrees: -12, latitude: 1, longitude: 2 },
      { timestamp: 3_000, speedMph: 40, speedValid: true, leanDegrees: null },
    ],
  });

  assert.equal(report.stats.maxSpeedMph, 40);
  assert.equal(report.stats.averageSpeedMph, null, "disconnected fixes do not invent time coverage");
  assert.equal(report.stats.maxLeanLeftDegrees, 12);
  assert.equal(report.stats.maxLeanRightDegrees, 0, "valid upright data distinguishes no right lean from no sensor");
  assert.deepEqual(report.location, { available: true, sampleCount: 1 });
});

test("average speed is trapezoidal time-weighted for irregular valid cadence", () => {
  const samples = [
    { timestamp: 0, speedMph: 100, speedValid: true, latitude: 1, longitude: 2 },
    { timestamp: 1_000, speedMph: 0, speedValid: true, latitude: 1, longitude: 2 },
    ...[2_000, 4_000, 6_000, 8_000, 10_000].map((timestamp) => ({
      timestamp,
      speedMph: 0,
      speedValid: true,
      latitude: 1,
      longitude: 2,
    })),
  ];
  const report = aggregateRunReport({ timing: timing(), samples });

  assert.equal(report.stats.averageSpeedMph, 5, "valid stationary coverage dominates elapsed time");
  assert.notEqual(report.stats.averageSpeedMph, 100 / samples.length, "the result is not a sample-count mean");
});

test("no valid location fix makes all GPS-derived report fields unavailable", () => {
  const report = aggregateRunReport({
    timing: timing({ endedAt: 2_000 }),
    samples: [
      { timestamp: 0, speedMph: 80, speedValid: true, leanDegrees: -25 },
      { timestamp: 1_000, speedMph: 90, speedValid: true, latitude: 91, longitude: 20 },
      { timestamp: 2_000, speedMph: 100, speedValid: true, latitude: 20, longitude: 181 },
    ],
  });

  assert.deepEqual(report.location, { available: false, sampleCount: 0 });
  assert.equal(report.stats.maxSpeedMph, null);
  assert.equal(report.stats.averageSpeedMph, null);
  assert.equal(report.topSpeedPoint, null);
  assert.equal(report.stats.maxLeanLeftDegrees, 25, "non-GPS statistics remain available");
  assert.ok(report.samples.every(({ latitude, longitude }) => latitude === null && longitude === null));
});

test("average requires valid measurable boundaries and does not bridge null or stale GPS gaps", () => {
  const boundaryReport = aggregateRunReport({
    timing: timing({ endedAt: 1_000 }),
    samples: [
      { timestamp: 0, speedMph: 0, speedValid: true, latitude: 1, longitude: 2 },
      { timestamp: 1_000, speedMph: 100, speedValid: true, latitude: 1, longitude: 2 },
    ],
  });
  assert.equal(boundaryReport.stats.averageSpeedMph, 50, "session boundary samples provide coverage");

  const gapReport = aggregateRunReport({
    timing: timing({ endedAt: 4_000 }),
    samples: [
      { timestamp: 0, speedMph: 60, speedValid: true, latitude: 1, longitude: 2 },
      { timestamp: 1_000, speedMph: null, speedValid: false, latitude: 1, longitude: 2 },
      { timestamp: 2_000, speedMph: 20, speedValid: true, latitude: 1, longitude: 2 },
      { timestamp: 4_000, speedMph: 20, speedValid: true, latitude: 1, longitude: 2 },
    ],
  });
  assert.equal(gapReport.stats.averageSpeedMph, 20, "null gap is excluded while recovered coverage remains");
});

test("long silent GPS gaps are excluded and recovery begins fresh time coverage", () => {
  const report = aggregateRunReport({
    timing: timing({ endedAt: 11_000 }),
    samples: [
      { timestamp: 0, speedMph: 60, speedValid: true, latitude: 1, longitude: 2 },
      { timestamp: 1_000, speedMph: 60, speedValid: true, latitude: 1, longitude: 2 },
      { timestamp: 2_500, speedMph: 60, speedValid: false, latitude: 1, longitude: 2 },
      { timestamp: 10_000, speedMph: 20, speedValid: true, latitude: 1, longitude: 2 },
      { timestamp: 11_000, speedMph: 20, speedValid: true, latitude: 1, longitude: 2 },
    ],
  });

  assert.equal(report.stats.averageSpeedMph, 40, "only the two proven one-second windows are weighted");
  assert.equal(report.stats.maxSpeedMph, 60);
});

test("top-speed ties prefer the first positioned maximum and normalize export context", () => {
  const report = aggregateRunReport({
    timing: timing({ endedAt: 4_000 }),
    samples: [
      { t: 900, timestamp: 500, speedMph: 100, speedValid: true },
      { t: -1, timestamp: 1_000, speedMph: 100, speedValid: true, latitude: 91, longitude: 20 },
      { t: 99_999, timestamp: 2_000, speedMph: 100, speedValid: true, latitude: 10, longitude: 20 },
      { timestamp: 3_000, speedMph: 100, speedValid: true, latitude: 11, longitude: 21 },
    ],
  });

  assert.deepEqual(report.topSpeedPoint.position, { latitude: 10, longitude: 20 });
  assert.equal(report.topSpeedPoint.timestamp, 2_000);
  assert.equal(report.topSpeedPoint.t, 2_000);
  assert.deepEqual(report.topSpeedPoint.lap, { index: 1, elapsedMs: 2_000, completed: false });
  assert.equal(report.samples[1].latitude, null, "out-of-range coordinates are normalized away");
});

test("aggregation requires an ended session, excludes out-of-session samples, and never mutates raw input", () => {
  assert.throws(
    () => aggregateRunReport({ timing: { ...timing(), endedAt: null }, samples: [] }),
    /ended lap-timing session/,
  );

  const raw = [
    { timestamp: -1, speedMph: 999, speedValid: true, latitude: 1, longitude: 2 },
    { timestamp: 0, speedMph: 10, speedValid: true, latitude: 1, longitude: 2 },
    { timestamp: 10_001, speedMph: 888, speedValid: true, latitude: 1, longitude: 2 },
  ];
  const before = structuredClone(raw);
  const rawTiming = timing();
  const timingBefore = structuredClone(rawTiming);
  const report = aggregateRunReport({ timing: rawTiming, samples: raw });

  assert.equal(report.stats.maxSpeedMph, 10);
  assert.equal(report.samples.length, 1);
  assert.deepEqual(raw, before);
  assert.deepEqual(rawTiming, timingBefore);
  assert.notEqual(report.samples[0], raw[1]);
  assert.ok(Object.isFrozen(report.samples[0]));
  assert.throws(() => {
    report.samples[0].speedMph = 999;
  }, TypeError);
});
