import test from "node:test";
import assert from "node:assert/strict";

import {
  adjustLapBoundary,
  adjustLapBoundaryIfAllowed,
  aggregateRunReport,
  LAP_TRIM_STEP_MS,
  lapTrimControls,
  MAX_LAP_TRIM_MS,
} from "../js/core/report.js";

function lap(index, startTime, endTime) {
  return { index, startTime, endTime, duration: endTime - startTime };
}

function report({ laps, endedAt, samples = [] }) {
  return aggregateRunReport({
    timing: {
      sessionStartTime: 0,
      currentLapStartTime: laps.at(-1)?.endTime ?? 0,
      lapNumber: laps.length + 1,
      laps,
      endedAt,
    },
    samples,
  });
}

test("interior boundary trim transfers exactly 0.1 s, conserves total, and is reversible", () => {
  const original = report({
    laps: [lap(1, 0, 10_000), lap(2, 10_000, 21_000), lap(3, 21_000, 30_000)],
    endedAt: 33_000,
  });

  const adjusted = adjustLapBoundary(original, 1, LAP_TRIM_STEP_MS);
  assert.deepEqual(adjusted.laps.map(({ startTime, endTime, duration }) => ({ startTime, endTime, duration })), [
    { startTime: 0, endTime: 10_100, duration: 10_100 },
    { startTime: 10_100, endTime: 21_000, duration: 10_900 },
    { startTime: 21_000, endTime: 30_000, duration: 9_000 },
  ]);
  assert.equal(adjusted.totalDurationMs, original.totalDurationMs);
  assert.deepEqual(adjusted.trim.originalBoundaries, [10_000, 21_000, 30_000]);
  assert.deepEqual(adjusted.trim.offsetsMs, [100, 0, 0]);
  assert.deepEqual(adjustLapBoundary(adjusted, 1, -LAP_TRIM_STEP_MS).laps, original.laps);
});

test("each boundary is capped non-walkably at ±0.5 s from its original tap", () => {
  let adjusted = report({ laps: [lap(1, 0, 10_000), lap(2, 10_000, 20_000)], endedAt: 25_000 });
  for (let step = 0; step < MAX_LAP_TRIM_MS / LAP_TRIM_STEP_MS; step += 1) {
    adjusted = adjustLapBoundary(adjusted, 1, LAP_TRIM_STEP_MS);
  }

  assert.equal(adjusted.trim.offsetsMs[0], 500);
  assert.deepEqual(lapTrimControls(adjusted, 1), {
    offsetMs: 500,
    canDecrease: true,
    canIncrease: false,
  });
  assert.throws(() => adjustLapBoundary(adjusted, 1, LAP_TRIM_STEP_MS), /cannot move farther/);
  assert.throws(() => adjustLapBoundary(adjusted, 1, 1), /exactly one 0.1 second step/);

  adjusted = adjustLapBoundary(adjusted, 1, -LAP_TRIM_STEP_MS);
  assert.equal(adjusted.trim.offsetsMs[0], 400, "one reverse step does not reset or walk the origin");
  assert.deepEqual(adjusted.trim.originalBoundaries, [10_000, 20_000]);
});

test("controls disable moves that would make a lap or unfinished tail nonpositive", () => {
  const tightInterior = report({
    laps: [lap(1, 0, 1_000), lap(2, 1_000, 1_050)],
    endedAt: 1_100,
  });
  assert.deepEqual(lapTrimControls(tightInterior, 1), {
    offsetMs: 0,
    canDecrease: true,
    canIncrease: false,
  });
  assert.deepEqual(lapTrimControls(tightInterior, 2), {
    offsetMs: 0,
    canDecrease: false,
    canIncrease: false,
  });
  assert.throws(() => adjustLapBoundary(tightInterior, 2, LAP_TRIM_STEP_MS), /cannot move farther/);
});

test("final completed-lap boundary moves against unfinished tail while session end stays fixed", () => {
  const original = report({
    laps: [lap(1, 0, 10_000), lap(2, 10_000, 20_000)],
    endedAt: 23_000,
  });
  const later = adjustLapBoundary(original, 2, LAP_TRIM_STEP_MS);

  assert.equal(later.laps[1].duration, 10_100);
  assert.deepEqual(later.unfinishedLap, {
    index: 3,
    startTime: 20_100,
    originalStartTime: 20_000,
    duration: 2_900,
  });
  assert.equal(later.endedAt, 23_000);
  assert.equal(later.totalDurationMs, 23_000);
});

test("a completed final boundary originally at session end can move earlier and restore exactly", () => {
  const original = report({
    laps: [lap(1, 0, 10_000), lap(2, 10_000, 20_000)],
    endedAt: 20_000,
  });

  const earlier = adjustLapBoundary(original, 2, -LAP_TRIM_STEP_MS);
  assert.equal(earlier.laps[1].endTime, 19_900);
  assert.equal(earlier.unfinishedLap.duration, 100);
  assert.equal(lapTrimControls(earlier, 2).canIncrease, true);

  const restored = adjustLapBoundary(earlier, 2, LAP_TRIM_STEP_MS);
  assert.deepEqual(restored.laps, original.laps);
  assert.equal(restored.unfinishedLap.duration, 0);
  assert.deepEqual(restored.trim.offsetsMs, [0, 0]);
  assert.equal(restored.totalDurationMs, original.totalDurationMs);
});

test("moving a boundary reassigns samples and immediately recomputes lap stats, best, and top-speed context", () => {
  const original = report({
    laps: [lap(1, 0, 1_000), lap(2, 1_000, 2_100)],
    endedAt: 2_500,
    samples: [
      { timestamp: 0, speedMph: 10, speedValid: true, latitude: 1, longitude: 2, leanDegrees: -2 },
      { timestamp: 950, speedMph: 90, speedValid: true, latitude: 1, longitude: 2, leanDegrees: -40 },
      { timestamp: 1_050, speedMph: 100, speedValid: true, latitude: 1, longitude: 2, leanDegrees: 35 },
      { timestamp: 2_000, speedMph: 20, speedValid: true, latitude: 1, longitude: 2, leanDegrees: 5 },
    ],
  });
  assert.deepEqual(original.lapStats.map(({ sampleCount }) => sampleCount), [2, 2]);
  assert.deepEqual(original.topSpeedPoint.lap, { index: 2, elapsedMs: 50, completed: true });
  assert.equal(original.bestLap.index, 1);

  const adjusted = adjustLapBoundary(original, 1, LAP_TRIM_STEP_MS);
  assert.deepEqual(adjusted.lapStats.map(({ sampleCount }) => sampleCount), [3, 1]);
  assert.equal(adjusted.lapStats[0].stats.maxSpeedMph, 100);
  assert.equal(adjusted.lapStats[0].stats.maxLeanRightDegrees, 35);
  assert.deepEqual(adjusted.samples[2].lap, { index: 1, elapsedMs: 1_050, completed: true });
  assert.deepEqual(adjusted.topSpeedPoint.lap, { index: 1, elapsedMs: 1_050, completed: true });
  assert.equal(adjusted.bestLap.index, 2, "best-lap header model changes with adjusted durations");
});

test("a sample exactly on a boundary belongs to the next lap and is reassigned only when the boundary passes it", () => {
  const original = report({
    laps: [lap(1, 0, 1_000), lap(2, 1_000, 2_000)],
    endedAt: 2_500,
    samples: [
      { timestamp: 1_000, speedMph: 50, speedValid: true, latitude: 1, longitude: 2 },
      { timestamp: 1_100, speedMph: 60, speedValid: true, latitude: 1, longitude: 2 },
    ],
  });
  assert.deepEqual(original.samples.map((sample) => sample.lap.index), [2, 2]);

  const adjusted = adjustLapBoundary(original, 1, LAP_TRIM_STEP_MS);
  assert.deepEqual(
    adjusted.samples.map((sample) => ({ index: sample.lap.index, elapsedMs: sample.lap.elapsedMs })),
    [{ index: 1, elapsedMs: 1_000 }, { index: 2, elapsedMs: 0 }],
    "the moved boundary remains the first instant of the next lap",
  );
});

test("fractional monotonic timestamps retain exact 100 ms offsets", () => {
  const fractional = aggregateRunReport(
    {
      timing: {
        sessionStartTime: 0.25,
        currentLapStartTime: 1_100.25,
        lapNumber: 2,
        laps: [lap(1, 0.25, 1_100.25)],
        endedAt: 1_500.25,
      },
      samples: [],
    },
    { originalLapBoundaries: [1_000.25], lapTrimOffsets: [100] },
  );
  assert.equal(fractional.laps[0].endTime, 1_100.25);
  assert.deepEqual(fractional.trim.originalBoundaries, [1_000.25]);
  assert.deepEqual(fractional.trim.offsetsMs, [100]);
  assert.equal(adjustLapBoundary(fractional, 1, -100).laps[0].endTime, 1_000.25);
});

test("report validation rejects sparse original-boundary and trim-offset arrays", () => {
  const baseTiming = {
    sessionStartTime: 0,
    currentLapStartTime: 2_000,
    lapNumber: 3,
    laps: [lap(1, 0, 1_000), lap(2, 1_000, 2_000)],
    endedAt: 2_500,
  };
  const sparseOriginals = [1_000, 2_000];
  delete sparseOriginals[1];
  const sparseOffsets = [0, 0];
  delete sparseOffsets[1];

  assert.throws(
    () => aggregateRunReport(
      { timing: baseTiming, samples: [] },
      { originalLapBoundaries: sparseOriginals, lapTrimOffsets: [0, 0] },
    ),
    /Original lap boundaries/,
  );
  assert.throws(
    () => aggregateRunReport(
      { timing: baseTiming, samples: [] },
      { originalLapBoundaries: [1_000, 2_000], lapTrimOffsets: sparseOffsets },
    ),
    /trim offsets/,
  );
  assert.throws(
    () => aggregateRunReport(
      { timing: baseTiming, samples: [] },
      { originalLapBoundaries: sparseOriginals, lapTrimOffsets: sparseOffsets },
    ),
    /Original lap boundaries/,
  );
});

test("report validation rejects fractional trim steps and original boundaries outside session order", () => {
  const baseTiming = {
    sessionStartTime: 0,
    currentLapStartTime: 1_050,
    lapNumber: 2,
    laps: [lap(1, 0, 1_050)],
    endedAt: 1_100,
  };
  assert.throws(
    () => aggregateRunReport(
      { timing: baseTiming, samples: [] },
      { originalLapBoundaries: [1_000], lapTrimOffsets: [50] },
    ),
    /0.1 second steps/,
  );
  assert.throws(
    () => aggregateRunReport(
      {
        timing: {
          ...baseTiming,
          currentLapStartTime: 1_100,
          laps: [lap(1, 0, 1_000), lap(2, 1_000, 1_100)],
          lapNumber: 3,
        },
        samples: [],
      },
      { originalLapBoundaries: [1_000, 900], lapTrimOffsets: [0, 200] },
    ),
    /monotonic and in session/,
  );
  assert.throws(
    () => aggregateRunReport(
      { timing: baseTiming, samples: [] },
      { originalLapBoundaries: [1_150], lapTrimOffsets: [-100] },
    ),
    /monotonic and in session/,
  );
  assert.throws(
    () => aggregateRunReport(
      {
        timing: {
          ...baseTiming,
          currentLapStartTime: 50,
          laps: [lap(1, 0, 50)],
        },
        samples: [],
      },
      { originalLapBoundaries: [-50], lapTrimOffsets: [100] },
    ),
    /monotonic and in session/,
  );
});

test("adjacent boundary moves respect each other's current position while allowing short positive laps", () => {
  let adjusted = report({
    laps: [lap(1, 0, 1_000), lap(2, 1_000, 1_150)],
    endedAt: 1_300,
  });
  adjusted = adjustLapBoundary(adjusted, 1, 100);
  assert.equal(adjusted.laps[1].duration, 50, "positive laps below 500 ms remain valid");
  assert.equal(lapTrimControls(adjusted, 2).canDecrease, false);
  adjusted = adjustLapBoundary(adjusted, 2, 100);
  assert.equal(adjusted.laps[1].duration, 150);
  assert.equal(adjusted.unfinishedLap.duration, 50);
  assert.ok(adjusted.laps.every((completed) => completed.duration > 0));
});

test("completed laps plus unfinished tail always conserve the ended session", () => {
  let adjusted = report({
    laps: [lap(1, 0, 1_000), lap(2, 1_000, 2_000), lap(3, 2_000, 3_000)],
    endedAt: 3_400,
  });
  for (const [lapIndex, delta] of [[1, 100], [2, -100], [3, 100], [1, 100]]) {
    adjusted = adjustLapBoundary(adjusted, lapIndex, delta);
    assert.equal(
      adjusted.laps.reduce((sum, completed) => sum + completed.duration, 0) + adjusted.unfinishedLap.duration,
      adjusted.totalDurationMs,
    );
  }
});

test("rapid repeated activations stop at the cap without throwing or walking the origin", () => {
  const original = report({ laps: [lap(1, 0, 5_000)], endedAt: 6_000 });
  let adjusted = original;
  for (let click = 0; click < 20; click += 1) {
    adjusted = adjustLapBoundaryIfAllowed(adjusted, 1, 100);
  }
  assert.equal(adjusted.trim.offsetsMs[0], 500);
  assert.equal(adjustLapBoundaryIfAllowed(adjusted, 1, 100), adjusted);
  assert.deepEqual(adjusted.trim.originalBoundaries, original.trim.originalBoundaries);
});

test("trimmed immutable report retains current and original boundaries for the save/export seam", () => {
  const original = report({ laps: [lap(1, 0, 5_000)], endedAt: 6_000 });
  const adjusted = adjustLapBoundary(original, 1, -LAP_TRIM_STEP_MS);

  assert.ok(Object.isFrozen(adjusted));
  assert.ok(Object.isFrozen(adjusted.trim));
  assert.ok(Object.isFrozen(adjusted.trim.originalBoundaries));
  assert.ok(Object.isFrozen(adjusted.samples));
  assert.equal(adjusted.laps[0].endTime, 4_900);
  assert.deepEqual(adjusted.trim.originalBoundaries, [5_000]);
  assert.deepEqual(adjusted.trim.offsetsMs, [-100]);
});
