import test from "node:test";
import assert from "node:assert/strict";

import {
  completeLap,
  currentLapElapsed,
  endLapTiming,
  formatLapTime,
  sessionElapsed,
  startLapTiming,
} from "../js/core/lap-timing.js";

test("lap timing is pure monotonic timestamp math", () => {
  const started = startLapTiming(10_000.25);
  assert.equal(started.lapNumber, 1);
  assert.equal(currentLapElapsed(started, 11_234.75), 1_234.5);

  const afterLapOne = completeLap(started, 71_239.75);
  assert.equal(afterLapOne.lapNumber, 2);
  assert.deepEqual(afterLapOne.laps[0], {
    index: 1,
    startTime: 10_000.25,
    endTime: 71_239.75,
    duration: 61_239.5,
  });
  assert.equal(currentLapElapsed(afterLapOne, 72_000), 760.25);
  assert.equal(started.laps.length, 0, "the input snapshot remains unchanged");
});

test("ending a race never records the unfinished current lap", () => {
  let timing = startLapTiming(500);
  timing = completeLap(timing, 60_600);
  timing = endLapTiming(timing, 75_650);

  assert.equal(timing.laps.length, 1);
  assert.equal(timing.lapNumber, 2);
  assert.equal(timing.endedAt, 75_650);
  assert.equal(sessionElapsed(timing), 75_150);
  assert.throws(() => completeLap(timing, 80_000), /already ended/);
});

test("MM:SS.d formatting floors to elapsed tenths without wall-clock dates", () => {
  assert.equal(formatLapTime(0), "00:00.0");
  assert.equal(formatLapTime(99.999), "00:00.0");
  assert.equal(formatLapTime(100), "00:00.1");
  assert.equal(formatLapTime(61_239.5), "01:01.2");
  assert.equal(formatLapTime(6_005_999), "100:05.9");
});

test("reordered or invalid timestamps are rejected", () => {
  const timing = startLapTiming(1_000);
  assert.throws(() => completeLap(timing, 999), /strictly after/);
  assert.throws(() => completeLap(timing, 1_000), /strictly after/);
  assert.throws(() => currentLapElapsed(timing, Number.NaN), /finite/);
  assert.throws(() => formatLapTime(-1), /non-negative/);
});
