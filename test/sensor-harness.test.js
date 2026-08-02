import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createGpsSpeedometer } from "../js/core/gps-speed.js";
import { createLeanEstimator } from "../js/core/lean-estimator.js";
import {
  createRawSensorLog,
  loadRawSensorLog,
  RAW_SENSOR_LOG_LEGACY_VERSION,
  RAW_SENSOR_LOG_VERSION,
  REPLAY_INITIALIZATION_ACTION,
  serializeRawSensorLog,
} from "../js/core/raw-sensor-log.js";
import {
  createRawSensorLogFile,
  createRawSensorRecorder,
  exportRawSensorLog,
} from "../js/core/recorder.js";
import {
  isRawRecorderExportEnabled,
  readDevSensorOptions,
  selectSensorSource,
} from "../js/dev/dev-sensor-source.js";
import { createReplaySensorSource, loadReplaySensorSource } from "../js/dev/replay.js";
import {
  createSyntheticSensorSource,
  createSyntheticSessionSamples,
  SYNTHETIC_SCENARIOS,
} from "../js/dev/simulator.js";
import { SENSOR_STATUS } from "../js/sensors/sensor-source.js";
import { createTimedSensorSource } from "../js/sensors/timed-sensor-source.js";

function manualTimers() {
  const pending = [];
  const cleared = [];
  let nextId = 1;

  function runNext() {
    while (pending.length) {
      const task = pending.shift();
      if (task.cancelled) continue;
      task.callback();
      return task.delay;
    }
    return null;
  }

  return {
    setTimeoutRef(callback, delay) {
      const id = nextId++;
      pending.push({ id, callback, delay, cancelled: false });
      return id;
    },
    clearTimeoutRef(id) {
      cleared.push(id);
      const task = pending.find((candidate) => candidate.id === id);
      if (task) task.cancelled = true;
    },
    runNext,
    drain() {
      const delays = [];
      while (pending.length) {
        const delay = runNext();
        if (delay !== null) delays.push(delay);
      }
      return delays;
    },
    cleared,
  };
}

function createLegacyRawSensorLog(samples, options = {}) {
  return createRawSensorLog(samples, {
    ...options,
    version: RAW_SENSOR_LOG_LEGACY_VERSION,
  });
}

function samplesInRange(samples, range, type) {
  return samples.filter(
    (sample) =>
      sample.type === type && sample.timestamp >= range.start && sample.timestamp <= range.end,
  );
}

function fakeSource() {
  const subscribers = new Set();
  let destroyed = false;
  return {
    requestAccess: async () => ({
      motion: { status: SENSOR_STATUS.GRANTED, reason: "" },
      location: { status: SENSOR_STATUS.GRANTED, reason: "" },
    }),
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    emit(sample) {
      for (const subscriber of subscribers) subscriber(sample);
    },
    destroy() {
      destroyed = true;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

test("synthetic sessions are byte-for-byte deterministic", () => {
  const first = createSyntheticSessionSamples();
  const second = createSyntheticSessionSamples();
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first[0].timestamp, 0);
  assert.equal(first.at(-1).timestamp, 38_000);
});

test("synthetic sessions include sustained corners, upright braking, and sub-15-mph manoeuvring", () => {
  const samples = createSyntheticSessionSamples();

  const cornerLocations = samplesInRange(samples, SYNTHETIC_SCENARIOS.sustainedCorner, "location");
  const cornerOrientations = samplesInRange(samples, SYNTHETIC_SCENARIOS.sustainedCorner, "orientation");
  assert.ok(cornerLocations.length >= 10);
  assert.ok(cornerLocations.every((sample) => sample.speed === 55 * 0.44704));
  assert.ok(cornerLocations.at(-1).heading - cornerLocations[0].heading >= 80);
  assert.ok(
    cornerOrientations.every(
      (sample) => sample.gamma === SYNTHETIC_SCENARIOS.sustainedCorner.trueLeanDegrees,
    ),
  );

  const brakingLocations = samplesInRange(samples, SYNTHETIC_SCENARIOS.uprightHardBraking, "location");
  const brakingOrientations = samplesInRange(samples, SYNTHETIC_SCENARIOS.uprightHardBraking, "orientation");
  assert.ok(brakingLocations[0].speed > 80 * 0.44704);
  assert.ok(brakingLocations.at(-1).speed < 15 * 0.44704);
  assert.ok(brakingLocations.every((sample) => sample.heading === 127.5));
  assert.ok(brakingOrientations.every((sample) => sample.gamma === 0));

  const paddock = samplesInRange(samples, SYNTHETIC_SCENARIOS.lowSpeedManoeuvring, "location");
  assert.ok(paddock.every((sample) => sample.speed < 15 * 0.44704));
  assert.notEqual(paddock[0].heading, paddock.at(-1).heading);

  const locations = samples.filter((sample) => sample.type === "location");
  const adjacentSpeedChangesMph = locations.slice(1).map(
    (sample, index) => Math.abs(sample.speed - locations[index].speed) / 0.44704,
  );
  assert.ok(
    Math.max(...adjacentSpeedChangesMph) <= 13,
    "no 500 ms GPS interval exceeds plausible hard-braking acceleration",
  );
});

test("simulator pitch deltas integrate from body-right gyro after removing leaned yaw", () => {
  const samples = createSyntheticSessionSamples();
  const orientations = new Map(
    samples.filter(({ type }) => type === "orientation").map((sample) => [sample.timestamp, sample]),
  );
  const motions = samples.filter(({ type }) => type === "motion");
  let integratedPitch = orientations.get(0).beta;

  for (let index = 1; index < motions.length; index += 1) {
    const motion = motions[index];
    const current = orientations.get(motion.timestamp);
    const previous = orientations.get(motions[index - 1].timestamp);
    const elapsedSeconds = (motion.timestamp - motions[index - 1].timestamp) / 1_000;
    const headingDelta = ((current.alpha - previous.alpha + 540) % 360) - 180;
    const yawRate = headingDelta / elapsedSeconds;
    const leanRadians = (current.gamma * Math.PI) / 180;
    const recoveredPitchRate = motion.rotationRate.x - yawRate * Math.sin(leanRadians);

    integratedPitch += recoveredPitchRate * elapsedSeconds;
    assert.ok(
      Math.abs(integratedPitch - current.beta) < 1e-9,
      `pitch gyro integration diverged at ${motion.timestamp} ms`,
    );
  }
});

test("simulator acceleration rotates gravity and longitudinal force through pitch and mount yaw", () => {
  const timestamp = 5_000;
  const untwisted = createSyntheticSessionSamples()
    .find((sample) => sample.type === "motion" && sample.timestamp === timestamp);
  const previousSpeedMph = 8 + 27 * ((timestamp - 100 - 4_000) / 2_000);
  const currentSpeedMph = 8 + 27 * ((timestamp - 4_000) / 2_000);
  const longitudinal = (currentSpeedMph - previousSpeedMph) * 0.44704 / 0.1;
  const pitch = -5 * Math.PI / 180;
  const expectedForward = longitudinal * Math.cos(pitch) + 9.80665 * Math.sin(pitch);
  const expectedVertical = -longitudinal * Math.sin(pitch) + 9.80665 * Math.cos(pitch);
  assert.ok(Math.abs(untwisted.accelerationIncludingGravity.y - expectedForward) < 1e-12);
  assert.ok(Math.abs(untwisted.accelerationIncludingGravity.z - expectedVertical) < 1e-12);

  const twisted = createSyntheticSessionSamples({ mountYawDegrees: 20 })
    .find((sample) => sample.type === "motion" && sample.timestamp === timestamp);
  const yaw = 20 * Math.PI / 180;
  assert.ok(Math.abs(twisted.accelerationIncludingGravity.x - expectedForward * Math.sin(yaw)) < 1e-12);
  assert.ok(Math.abs(twisted.accelerationIncludingGravity.y - expectedForward * Math.cos(yaw)) < 1e-12);
  assert.ok(Math.abs(twisted.accelerationIncludingGravity.z - expectedVertical) < 1e-12);
});

test("the simulator implements the normalized source seam with explicit body-rate axes", async () => {
  const timers = manualTimers();
  const source = createSyntheticSensorSource({
    samples: createSyntheticSessionSamples({ durationMs: 34_000 }).slice(0, 5),
    loop: false,
    ...timers,
  });
  assert.deepEqual(Object.keys(source).sort(), ["destroy", "requestAccess", "subscribe"]);

  const emitted = [];
  source.subscribe((sample) => emitted.push(sample));
  const outcomes = await source.requestAccess();
  timers.drain();

  assert.equal(outcomes.motion.status, SENSOR_STATUS.GRANTED);
  assert.equal(outcomes.location.status, SENSOR_STATUS.GRANTED);
  assert.equal(emitted.length, 5);
  assert.ok(
    emitted.every((sample) =>
      sample.type === "orientation" || sample.type === "motion" || sample.type === "location",
    ),
  );
  assert.ok(emitted.every((sample) => !("scenario" in sample)));
  const motion = emitted.find((sample) => sample.type === "motion");
  assert.deepEqual(Object.keys(motion.rotationRate).sort(), ["x", "y", "z"]);
  assert.equal("alpha" in motion.rotationRate, false);
});

test("recorder captures timestamped samples before downstream mutation and ignores access events", () => {
  const source = fakeSource();
  const recorder = createRawSensorRecorder(source);
  assert.throws(() => recorder.startRecording(), /initialization action is required/);
  recorder.setReplayWithoutLean();
  recorder.startRecording();
  recorder.subscribe((sample) => {
    if (sample.type === "orientation") sample.gamma = 999;
  });

  source.emit({ type: "orientation", timestamp: 10, alpha: 20, beta: 3, gamma: 4 });
  source.emit({ type: "access", sensor: "location", outcome: { status: "granted" } });
  source.emit({ type: "location", timestamp: 20, latitude: 1, longitude: 2, speed: 3 });
  const log = recorder.stopRecording();

  assert.deepEqual(log.samples, [
    { type: "orientation", timestamp: 10, alpha: 20, beta: 3, gamma: 4 },
    { type: "location", timestamp: 20, latitude: 1, longitude: 2, speed: 3 },
  ]);
  source.emit({ type: "orientation", timestamp: 30, gamma: 8 });
  assert.equal(recorder.getRecording().samples.length, 2, "recording stops at the session boundary");

  recorder.destroy();
  assert.equal(source.destroyed, true);
});

test("nested raw values are defensively cloned at recorder, log, and timed-source boundaries", async () => {
  const source = fakeSource();
  let now = 0;
  const recorder = createRawSensorRecorder(source, { nowRef: () => now });
  recorder.setReplayWithoutLean();
  recorder.startRecording();
  recorder.subscribe((sample) => {
    sample.motion.rotationRate.alpha = 999;
    sample.motion.axes[0].value = 999;
  });

  const reading = {
    type: "orientation",
    timestamp: 10,
    motion: { rotationRate: { alpha: 4 }, axes: [{ value: 5 }] },
  };
  now = 10;
  source.emit(reading);
  const log = recorder.stopRecording();
  assert.equal(log.samples[0].motion.rotationRate.alpha, 4);
  assert.equal(log.samples[0].motion.axes[0].value, 5);

  reading.motion.rotationRate.alpha = 888;
  log.samples[0].motion.axes[0].value = 777;
  const freshLog = recorder.getRecording();
  assert.equal(freshLog.samples[0].motion.rotationRate.alpha, 4);
  assert.equal(freshLog.samples[0].motion.axes[0].value, 5);

  const logInput = [{ type: "orientation", timestamp: 20, nested: { values: [1, { value: 2 }] } }];
  const ownedLog = createLegacyRawSensorLog(logInput);
  logInput[0].nested.values[1].value = 333;
  assert.equal(ownedLog.samples[0].nested.values[1].value, 2);

  const timers = manualTimers();
  const replay = createReplaySensorSource(ownedLog, { ...timers });
  const secondSubscriberReadings = [];
  replay.subscribe((sample) => {
    sample.nested.values[1].value = 444;
  });
  replay.subscribe((sample) => secondSubscriberReadings.push(sample));
  await replay.requestAccess();
  timers.drain();
  assert.equal(secondSubscriberReadings[0].nested.values[1].value, 2);
  assert.equal(ownedLog.samples[0].nested.values[1].value, 2);
});

test("record/export/load/replay restores calibration and pre-race estimator state without losing samples", async () => {
  const source = fakeSource();
  let now = 0;
  const recorder = createRawSensorRecorder(source, { nowRef: () => now });
  const gravity = { x: 0, y: 0, z: 9.80665 };
  const preCalibrationSamples = [
    {
      type: "location",
      timestamp: 50,
      latitude: 37,
      longitude: -122,
      accuracy: 3,
      speed: 20,
      heading: 0,
    },
  ];
  const initializationSamples = [
    {
      type: "motion",
      timestamp: 60,
      accelerationIncludingGravity: gravity,
      rotationRate: { x: 0, y: 0, z: 0 },
    },
  ];
  const raceSamples = [
    {
      type: "motion",
      timestamp: 100,
      accelerationIncludingGravity: gravity,
      rotationRate: { x: 0, y: 20, z: 0 },
    },
    {
      type: "motion",
      timestamp: 200,
      accelerationIncludingGravity: gravity,
      rotationRate: { x: 0, y: 20, z: -8 },
    },
    {
      type: "location",
      timestamp: 250,
      latitude: 37.0001,
      longitude: -122,
      accuracy: 3,
      speed: 20,
      heading: 2,
    },
    {
      type: "motion",
      timestamp: 300,
      accelerationIncludingGravity: gravity,
      rotationRate: { x: 0, y: 0, z: -8 },
    },
  ];

  function estimatorPipeline() {
    const speedometer = createGpsSpeedometer();
    const estimator = createLeanEstimator({ nowRef: () => 0 });
    const readings = [];
    return {
      estimator,
      readings,
      handle(sample) {
        if (sample.type === "location") {
          speedometer.handle(sample);
          estimator.update(speedometer.kinematicSample());
        } else {
          speedometer.handle(sample);
          estimator.update(sample);
        }
        readings.push({
          type: sample.type,
          timestamp: sample.timestamp,
          speed: speedometer.snapshot(),
          lean: estimator.snapshot(),
        });
      },
    };
  }

  const live = estimatorPipeline();
  recorder.subscribe((sample) => live.handle(sample));
  for (const [index, sample] of preCalibrationSamples.entries()) {
    now = index * 50;
    source.emit(sample);
  }
  live.estimator.calibrate(gravity);
  recorder.setReplayCalibration(gravity);
  for (const [index, sample] of initializationSamples.entries()) {
    now = 50 + index * 50;
    source.emit(sample);
  }
  const liveRaceStart = live.estimator.snapshot();
  now = 100;
  recorder.startRecording();
  for (const [index, sample] of raceSamples.entries()) {
    now = 100 + index * 50;
    source.emit(sample);
  }
  const liveRaceReadings = live.readings.slice(
    preCalibrationSamples.length + initializationSamples.length,
  );
  const exportedFile = createRawSensorLogFile(recorder.stopRecording(), {
    FileRef: undefined,
    BlobRef: Blob,
  });
  const loaded = await loadRawSensorLog(exportedFile);

  assert.equal(loaded.version, RAW_SENSOR_LOG_VERSION);
  assert.deepEqual(loaded.replayInitialization.action, {
    type: REPLAY_INITIALIZATION_ACTION.CALIBRATE,
    gravity,
  });
  assert.equal(loaded.replayInitialization.actionSampleCount, preCalibrationSamples.length);
  assert.deepEqual(
    loaded.replayInitialization.samples,
    [...preCalibrationSamples, ...initializationSamples],
  );
  assert.deepEqual(loaded.samples, raceSamples);

  async function replayOnce() {
    const timers = manualTimers();
    const replay = createReplaySensorSource(loaded, timers);
    const pipeline = estimatorPipeline();
    const emitted = [];
    replay.subscribe((sample) => {
      emitted.push(sample);
      pipeline.handle(sample);
    });

    await replay.requestAccess();
    assert.deepEqual(emitted, [], "sensor access does not consume initialization or race samples");
    const actionReady = replay.initializeAction();
    timers.drain();
    await actionReady;
    assert.deepEqual(emitted, preCalibrationSamples);
    pipeline.estimator.calibrate(replay.getReplayInitialization().action.gravity);
    const initializationDone = replay.initializeReplay();
    timers.drain();
    await initializationDone;
    assert.deepEqual(
      emitted,
      [...preCalibrationSamples, ...initializationSamples],
      "race samples stay gated until the app enters Race",
    );
    assert.deepEqual(pipeline.estimator.snapshot(), liveRaceStart);

    replay.startReplay();
    timers.drain();
    assert.deepEqual(
      emitted,
      [...preCalibrationSamples, ...initializationSamples, ...raceSamples],
    );
    return pipeline.readings.slice(preCalibrationSamples.length + initializationSamples.length);
  }

  const firstReplay = await replayOnce();
  const secondReplay = await replayOnce();
  assert.deepEqual(firstReplay, liveRaceReadings);
  assert.deepEqual(secondReplay, firstReplay);

  const mainSource = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
  const initializeAt = mainSource.indexOf("await sensorSource.initializeReplay()");
  const sessionStartAt = mainSource.indexOf("sessionRecorder.start(now)", initializeAt);
  const releaseRaceAt = mainSource.indexOf("sensorSource.startReplay?.()", sessionStartAt);
  assert.ok(initializeAt >= 0 && initializeAt < sessionStartAt);
  assert.ok(sessionStartAt < releaseRaceAt, "the app records before Race sample 1 is released");
  assert.match(mainSource, /leanEstimator\.calibrate\(replayInitialization\.action\.gravity\)/);
});

test("degraded GPS-only, no-sensor, and gyro-stall recordings emit gated v2 no-lean replays", async () => {
  const scenarios = [
    {
      name: "motion denied GPS-only",
      preAction: [{
        type: "location",
        timestamp: 10,
        latitude: 37,
        longitude: -122,
        speed: 0,
      }],
      postAction: [{
        type: "location",
        timestamp: 20,
        latitude: 37.00001,
        longitude: -122,
        speed: 5,
      }],
      race: [{
        type: "location",
        timestamp: 30,
        latitude: 37.00002,
        longitude: -122,
        speed: 10,
      }],
    },
    {
      name: "granted motion with stalled gyro",
      preAction: [{ type: "orientation", timestamp: 100, alpha: 0, beta: 0, gamma: 0 }],
      postAction: [{ type: "orientation", timestamp: 110, alpha: 0, beta: 0, gamma: 0 }],
      race: [{ type: "location", timestamp: 120, latitude: 37, longitude: -122, speed: 12 }],
    },
    {
      name: "motion and location unavailable",
      preAction: [],
      postAction: [],
      race: [],
    },
  ];

  for (const scenario of scenarios) {
    const source = fakeSource();
    let now = 0;
    const recorder = createRawSensorRecorder(source, { nowRef: () => now });
    for (const sample of scenario.preAction) {
      now += 10;
      source.emit(sample);
    }
    recorder.setReplayWithoutLean();
    for (const sample of scenario.postAction) {
      now += 10;
      source.emit(sample);
    }
    recorder.startRecording();
    for (const sample of scenario.race) {
      now += 10;
      source.emit(sample);
    }
    const loaded = await loadRawSensorLog(serializeRawSensorLog(recorder.stopRecording()));
    assert.equal(loaded.version, RAW_SENSOR_LOG_VERSION, scenario.name);
    assert.deepEqual(loaded.replayInitialization.action, {
      type: REPLAY_INITIALIZATION_ACTION.CONTINUE_WITHOUT_LEAN,
    });
    assert.equal(loaded.replayInitialization.actionSampleCount, scenario.preAction.length);

    const timers = manualTimers();
    const replay = createReplaySensorSource(loaded, timers);
    const emitted = [];
    replay.subscribe((sample) => emitted.push(sample));
    await replay.requestAccess();
    assert.deepEqual(emitted, [], `${scenario.name}: access remains gated`);
    const actionReady = replay.initializeAction();
    timers.drain();
    await actionReady;
    assert.deepEqual(emitted, scenario.preAction);
    const initialized = replay.initializeReplay();
    timers.drain();
    await initialized;
    assert.deepEqual(emitted, [...scenario.preAction, ...scenario.postAction]);
    replay.startReplay();
    timers.drain();
    assert.deepEqual(emitted, [...scenario.preAction, ...scenario.postAction, ...scenario.race]);
  }

  const mainSource = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
  assert.ok(
    mainSource.match(/rawRecorder\?\.setReplayWithoutLean\(\)/g)?.length >= 2,
    "both unavailable motion and gyro-timeout actions are recorded",
  );
});

test("raw log export creates a loadable in-memory JSON file", async () => {
  const log = createLegacyRawSensorLog([{ type: "orientation", timestamp: 1, gamma: 2 }]);
  const file = createRawSensorLogFile(log, { FileRef: undefined, BlobRef: Blob });
  assert.equal(file.name, "trackmaster-raw-sensors.json");
  assert.equal(file.type, "application/json");
  assert.deepEqual(await loadRawSensorLog(file), log);
  assert.deepEqual(await loadRawSensorLog(serializeRawSensorLog(log)), log);
});

test("export uses the share sheet without touching browser persistence", async () => {
  const log = createLegacyRawSensorLog([{ type: "location", timestamp: 1, speed: 4 }]);
  const shared = [];
  const file = await exportRawSensorLog(log, {
    navigatorRef: {
      canShare: ({ files }) => files.length === 1,
      share: async (payload) => shared.push(payload),
    },
    FileRef: undefined,
    BlobRef: Blob,
  });
  assert.equal(shared.length, 1);
  assert.equal(shared[0].files[0], file);

  const recorderSource = await readFile(new URL("../js/core/recorder.js", import.meta.url), "utf8");
  assert.doesNotMatch(recorderSource, /localStorage|indexedDB|sessionStorage/);
});

test("Blob download fallback revokes its transient object URL", async () => {
  const log = createLegacyRawSensorLog([{ type: "orientation", timestamp: 1, gamma: 2 }]);
  const calls = [];
  const anchor = {
    click: () => calls.push("click"),
    remove: () => calls.push("remove"),
  };
  await exportRawSensorLog(log, {
    navigatorRef: {},
    documentRef: {
      body: { append: () => calls.push("append") },
      createElement: () => anchor,
    },
    URLRef: {
      createObjectURL: () => "blob:raw-log",
      revokeObjectURL: (url) => calls.push(`revoke:${url}`),
    },
    setTimeoutRef: (callback) => callback(),
    FileRef: undefined,
    BlobRef: Blob,
  });
  assert.deepEqual(calls, ["append", "click", "remove", "revoke:blob:raw-log"]);
  assert.equal(anchor.download, "trackmaster-raw-sensors.json");
});

test("Blob download fallback cleans up when anchor setup or click throws", async () => {
  const log = createLegacyRawSensorLog([{ type: "orientation", timestamp: 1, gamma: 2 }]);

  for (const failurePoint of ["setup", "click"]) {
    const calls = [];
    const anchor = {
      set href(value) {
        calls.push(`href:${value}`);
        if (failurePoint === "setup") throw new Error("setup failed");
      },
      click() {
        calls.push("click");
        if (failurePoint === "click") throw new Error("click failed");
      },
      remove() {
        calls.push("remove");
      },
    };

    await assert.rejects(
      () =>
        exportRawSensorLog(log, {
          navigatorRef: {},
          documentRef: {
            body: { append: () => calls.push("append") },
            createElement: () => anchor,
          },
          URLRef: {
            createObjectURL: () => "blob:failed-log",
            revokeObjectURL: (url) => calls.push(`revoke:${url}`),
          },
          setTimeoutRef: () => {
            throw new Error("revocation should be immediate after failure");
          },
          FileRef: undefined,
          BlobRef: Blob,
        }),
      new RegExp(`${failurePoint} failed`),
    );
    assert.ok(calls.includes("remove"));
    assert.ok(calls.includes("revoke:blob:failed-log"));
  }
});

test("playback rate scales explicit replay delays without changing readings", async () => {
  const timers = manualTimers();
  const readings = [
    { type: "orientation", timestamp: 100, nested: { value: 1 } },
    { type: "orientation", timestamp: 200, nested: { value: 2 } },
    { type: "location", timestamp: 300, nested: { value: 3 } },
  ];
  const source = createReplaySensorSource(
    createLegacyRawSensorLog(readings, { deliveryOffsetsMs: [0, 200, 500] }),
    { playbackRate: 2, ...timers },
  );
  const emitted = [];
  source.subscribe((sample) => emitted.push(sample));
  await source.requestAccess();

  assert.equal(timers.runNext(), 0);
  assert.equal(timers.runNext(), 100);
  assert.equal(timers.runNext(), 150);
  assert.deepEqual(emitted, readings);
});

test("destroy rejects pending v2 action and post-action initialization phases without hanging", async () => {
  function phaseLog(actionSampleCount) {
    return createRawSensorLog(
      [{ type: "location", timestamp: 300, latitude: 1, longitude: 2, speed: 3 }],
      {
        replayInitialization: {
          action: { type: REPLAY_INITIALIZATION_ACTION.CONTINUE_WITHOUT_LEAN },
          actionSampleCount,
          samples: [
            { type: "orientation", timestamp: 100 },
            { type: "orientation", timestamp: 200 },
          ],
          deliveryOffsetsMs: [0, 100],
        },
      },
    );
  }

  const actionTimers = manualTimers();
  const actionReplay = createReplaySensorSource(phaseLog(2), actionTimers);
  const actionEmitted = [];
  actionReplay.subscribe((sample) => actionEmitted.push(sample));
  const pendingAction = actionReplay.initializeAction();
  assert.equal(actionTimers.runNext(), 0);
  actionReplay.destroy();
  await assert.rejects(pendingAction, /destroyed during initialization/);
  actionTimers.drain();
  assert.equal(actionEmitted.length, 1);

  const postTimers = manualTimers();
  const postReplay = createReplaySensorSource(phaseLog(0), postTimers);
  await postReplay.initializeAction();
  const pendingPostAction = postReplay.initializeReplay();
  assert.equal(postTimers.runNext(), 0);
  postReplay.destroy();
  await assert.rejects(pendingPostAction, /destroyed during initialization/);
  postTimers.drain();
});

test("destroy cancels the timed source's pending callback", async () => {
  const timers = manualTimers();
  const source = createTimedSensorSource([
    { type: "orientation", timestamp: 0 },
    { type: "orientation", timestamp: 100 },
  ], timers);
  const emitted = [];
  source.subscribe((sample) => emitted.push(sample));
  await source.requestAccess();
  assert.equal(timers.runNext(), 0);
  assert.equal(emitted.length, 1);

  source.destroy();
  assert.deepEqual(timers.cleared, [2]);
  assert.deepEqual(timers.drain(), []);
  assert.equal(emitted.length, 1);
});

test("two replays emit identical readings and preserve original timestamps", async () => {
  const readings = createSyntheticSessionSamples({ durationMs: 34_000 }).slice(0, 20);
  const log = createLegacyRawSensorLog(readings);

  async function replayOnce() {
    const timers = manualTimers();
    const source = createReplaySensorSource(log, { playbackRate: 16, ...timers });
    const emitted = [];
    source.subscribe((sample) => emitted.push(sample));
    await source.requestAccess();
    timers.drain();
    return emitted;
  }

  const first = await replayOnce();
  const second = await replayOnce();
  assert.deepEqual(first, readings);
  assert.deepEqual(second, first);
  assert.deepEqual(
    first.map(({ timestamp }) => timestamp),
    readings.map(({ timestamp }) => timestamp),
  );
});

test("raw log validation dispatches valid v1/v2 contracts and rejects malformed v2 metadata", async () => {
  const legacyLog = createLegacyRawSensorLog([
    { type: "orientation", timestamp: 1, gamma: 2 },
    { type: "location", timestamp: 2, speed: 3 },
  ]);
  assert.equal(legacyLog.version, RAW_SENSOR_LOG_LEGACY_VERSION);
  assert.equal("replayInitialization" in legacyLog, false);
  const legacyTimers = manualTimers();
  const legacySource = await loadReplaySensorSource(serializeRawSensorLog(legacyLog), legacyTimers);
  const legacyEmitted = [];
  legacySource.subscribe((sample) => legacyEmitted.push(sample));
  await legacySource.requestAccess();
  legacyTimers.drain();
  assert.deepEqual(legacyEmitted, legacyLog.samples, "v1 retains play-on-access behavior");

  const version2Log = createRawSensorLog(legacyLog.samples, {
    deliveryOffsetsMs: legacyLog.deliveryOffsetsMs,
    replayInitialization: {
      action: { type: REPLAY_INITIALIZATION_ACTION.CONTINUE_WITHOUT_LEAN },
      actionSampleCount: 0,
      samples: [],
      deliveryOffsetsMs: [],
    },
  });
  assert.equal(version2Log.version, RAW_SENSOR_LOG_VERSION);
  assert.deepEqual(await loadRawSensorLog(serializeRawSensorLog(version2Log)), version2Log);

  await assert.rejects(() => loadRawSensorLog("not JSON"), /Invalid raw sensor log JSON/);
  assert.throws(
    () => createLegacyRawSensorLog([{ type: "orientation", timestamp: 1, gamma: undefined }]),
    /JSON cannot preserve/,
  );
  await assert.rejects(
    () => loadRawSensorLog({ ...legacyLog, deliveryOffsetsMs: [2, 1] }),
    /ordered/,
  );
  const version2Base = { ...legacyLog, version: RAW_SENSOR_LOG_VERSION };
  await assert.rejects(
    () => loadRawSensorLog(version2Base),
    /Version 2 raw logs require replay initialization metadata/,
  );
  await assert.rejects(
    () => loadRawSensorLog({ ...version2Base, replayInitialization: {} }),
    /Replay initialization samples must be an array/,
  );
  await assert.rejects(
    () => loadRawSensorLog({
      ...version2Base,
      replayInitialization: {
        action: { type: REPLAY_INITIALIZATION_ACTION.CALIBRATE },
        actionSampleCount: 0,
        samples: [],
        deliveryOffsetsMs: [],
      },
    }),
    /Replay calibration action must contain finite gravity/,
  );
  await assert.rejects(
    () => loadRawSensorLog({
      ...version2Base,
      replayInitialization: {
        action: { type: REPLAY_INITIALIZATION_ACTION.CONTINUE_WITHOUT_LEAN },
        samples: [],
        deliveryOffsetsMs: [],
      },
    }),
    /Replay action sample count/,
  );
  await assert.rejects(
    () => loadRawSensorLog({
      ...version2Base,
      replayInitialization: {
        action: { type: REPLAY_INITIALIZATION_ACTION.CONTINUE_WITHOUT_LEAN },
        actionSampleCount: 0,
        samples: [{ type: "motion", timestamp: 0 }],
      },
    }),
    /Replay initialization delivery offsets must match/,
  );

  const mixedClockLog = createLegacyRawSensorLog(
    [
      { type: "orientation", timestamp: 20 },
      { type: "location", timestamp: 1_700_000_000_000 },
      { type: "orientation", timestamp: 21 },
    ],
    { deliveryOffsetsMs: [0, 500, 510] },
  );
  assert.deepEqual((await loadRawSensorLog(mixedClockLog)).samples, mixedClockLog.samples);
});

test("dev source flags are URL-only and normal flow returns the browser source unchanged", async () => {
  const browserSource = fakeSource();
  const mainSource = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
  assert.match(
    mainSource,
    /rawRecorder = exportRawRecording \? createRawSensorRecorder\(selectedSensorSource\) : null/,
  );
  assert.match(mainSource, /sensorSource = rawRecorder \?\? selectedSensorSource/);
  assert.deepEqual(readDevSensorOptions(""), {
    mode: null,
    playbackRate: 1,
    replayLogUrl: null,
  });
  assert.equal(await selectSensorSource({ search: "", browserSource }), browserSource);
  assert.equal(
    await selectSensorSource({ search: "?dev-sensors=unknown", browserSource }),
    browserSource,
  );
  assert.equal(isRawRecorderExportEnabled("?dev-recorder=1"), true);
  assert.throws(
    () => readDevSensorOptions("?dev-recorder=1&dev-sensors=simulator"),
    /supports real hardware only/,
  );
  await assert.rejects(
    () => selectSensorSource({
      search: "?dev-recorder=1&dev-sensors=replay&replay-log=ride.json",
      browserSource,
      fetchRef: async () => { throw new Error("must reject before fetch"); },
    }),
    /supports real hardware only/,
  );

  const timers = manualTimers();
  const simulator = await selectSensorSource({
    search: "?dev-sensors=simulator&dev-rate=4",
    browserSource,
    simulatorOptions: {
      samples: createSyntheticSessionSamples({ durationMs: 34_000 }).slice(0, 2),
      loop: false,
      ...timers,
    },
  });
  assert.notEqual(simulator, browserSource);
  assert.deepEqual(Object.keys(simulator).sort(), ["destroy", "requestAccess", "subscribe"]);
});

test("replay URL flag loads a stateless file through the unified source selector", async () => {
  const log = createLegacyRawSensorLog([{ type: "orientation", timestamp: 5, gamma: 6 }]);
  const timers = manualTimers();
  let requestedUrl;
  const source = await selectSensorSource({
    search: "?dev-sensors=replay&replay-log=fixtures%2Fride.json&dev-rate=2",
    browserSource: fakeSource(),
    fetchRef: async (url) => {
      requestedUrl = url;
      return { ok: true, text: async () => serializeRawSensorLog(log) };
    },
    replayOptions: timers,
  });
  const emitted = [];
  source.subscribe((sample) => emitted.push(sample));
  await source.requestAccess();
  timers.drain();
  assert.equal(requestedUrl, "fixtures/ride.json");
  assert.deepEqual(emitted, log.samples);
});
