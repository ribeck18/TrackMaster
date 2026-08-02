import test from "node:test";
import assert from "node:assert/strict";

import { createSessionRecorder } from "../js/core/session-recorder.js";

test("session recorder keeps timestamped position, speed, and lean readings", () => {
  const recorder = createSessionRecorder({ minimumIntervalMs: 50 });
  recorder.start(1_000);
  assert.equal(recorder.record({
    position: { latitude: 37.42, longitude: -122.08, timestamp: 1_722_513_600_000 },
    speedMph: 87,
    speedValid: true,
    leanDegrees: -42.25,
  }, 1_000), true);
  assert.equal(recorder.record({ speedMph: 88, speedValid: false, leanDegrees: -43 }, 1_020), false);
  assert.equal(recorder.record({ speedMph: 88, speedValid: false, leanDegrees: -43 }, 1_020, { force: true }), true);

  const session = recorder.stop(2_000);
  assert.deepEqual(session.samples[0], {
    t: 0,
    timestamp: 1_000,
    latitude: 37.42,
    longitude: -122.08,
    locationTimestamp: 1_722_513_600_000,
    speedMph: 87,
    speedValid: true,
    leanDegrees: -42.25,
  });
  assert.deepEqual(session.samples[1], {
    t: 20,
    timestamp: 1_020,
    latitude: null,
    longitude: null,
    locationTimestamp: null,
    speedMph: 88,
    speedValid: false,
    leanDegrees: -43,
  });
  assert.equal(recorder.record({}, 2_100), false);
});

test("forced and non-forced samples reject reordering and coalesce duplicate instants", () => {
  const recorder = createSessionRecorder({ minimumIntervalMs: 50 });
  recorder.start(0);
  assert.equal(recorder.record({ speedMph: 10 }, 0), true);
  assert.equal(recorder.record({ speedMph: 11 }, 20), false);
  assert.throws(() => recorder.record({ speedMph: 9 }, 10), /monotonic/);

  recorder.start(0);
  assert.equal(recorder.record({ speedMph: 10 }, 0, { force: true }), true);
  assert.equal(recorder.record({ speedMph: 12 }, 0, { force: true }), false);
  assert.equal(recorder.sampleCount(), 1);
  assert.deepEqual(recorder.stop(0).samples.map(({ timestamp, speedMph }) => ({ timestamp, speedMph })), [
    { timestamp: 0, speedMph: 12 },
  ]);

  recorder.start(0);
  recorder.record({}, 20, { force: true });
  assert.throws(() => recorder.record({}, 19, { force: true }), /monotonic/);
});

test("stop rejects an end timestamp before recorded or cadence-throttled readings", () => {
  const recorder = createSessionRecorder();
  recorder.start(0);
  recorder.record({ speedMph: 80 }, 100, { force: true });
  assert.throws(() => recorder.stop(99), /last seen reading/);
  assert.equal(recorder.isRecording(), true);
  assert.equal(recorder.stop(100).endedAt, 100);

  recorder.start(0);
  recorder.record({ speedMph: 80 }, 0);
  assert.equal(recorder.record({ speedMph: 81 }, 20), false, "reading is cadence-throttled");
  assert.equal(recorder.sampleCount(), 1);
  assert.throws(() => recorder.stop(19), /last seen reading/);
  assert.equal(recorder.isRecording(), true);
  assert.equal(recorder.stop(20).endedAt, 20);
});

test("native GPS samples may supplement 20 Hz capture without duplicate floods", () => {
  const recorder = createSessionRecorder({ minimumIntervalMs: 50, minimumForcedIntervalMs: 10 });
  recorder.start(0);
  recorder.record({ speedMph: 70 }, 0);
  recorder.record({ position: { latitude: 1, longitude: 2 }, speedMph: 71 }, 25, { force: true });
  recorder.record({ speedMph: 72 }, 50);
  assert.equal(recorder.sampleCount(), 3, "a native GPS fix is retained between instrument samples");

  recorder.start(0);
  for (let timestamp = 0; timestamp <= 1_000; timestamp += 0.5) {
    recorder.record({ position: { latitude: 1, longitude: 2 } }, timestamp, { force: true });
  }
  const flooded = recorder.stop(1_000);
  assert.ok(flooded.samples.length >= 100);
  assert.ok(flooded.samples.length <= 101, "forced duplicates are bounded at 100 Hz");
  assert.equal(flooded.samples.at(-1).timestamp, 1_000, "coalescing retains the newest fix");
});

test("20 Hz instrument capture remains bounded through a full 20 minute 60 Hz session", () => {
  const recorder = createSessionRecorder({ minimumIntervalMs: 50 });
  recorder.start(0);
  for (let timestamp = 0; timestamp <= 20 * 60_000; timestamp += 1000 / 60) {
    recorder.record({ speedMph: 80, leanDegrees: 30 }, timestamp);
  }
  const session = recorder.stop(20 * 60_000);

  assert.ok(session.samples.length >= 18_000);
  assert.ok(session.samples.length <= 24_001);
  assert.equal(session.samples[0].t, 0);
  assert.ok(session.samples.at(-1).t <= 20 * 60_000);
});
