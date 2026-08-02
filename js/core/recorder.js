import { cloneJsonValue } from "./json-value.js";
import {
  createRawSensorLog,
  REPLAY_INITIALIZATION_ACTION,
  serializeRawSensorLog,
} from "./raw-sensor-log.js";

/**
 * Records directly at the unified source seam, before any subscriber can
 * filter, smooth, or derive values from the reading.
 */
export function createRawSensorRecorder(source, {
  nowRef = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now,
} = {}) {
  if (!source || typeof source.requestAccess !== "function" || typeof source.subscribe !== "function") {
    throw new TypeError("Recorder requires a sensor source.");
  }

  const subscribers = new Set();
  let samples = [];
  let deliveryOffsetsMs = [];
  let recordingStartedAt = 0;
  let recording = false;
  let destroyed = false;
  let replayAction = null;
  let actionSampleCount = null;
  let initializationSamples = [];
  let initializationDeliveryOffsetsMs = [];
  let initializationStartedAt = nowRef();
  let recordingReplayInitialization = undefined;

  function appendReading(targetSamples, targetOffsets, sample, startedAt, label) {
    if (!Number.isFinite(sample?.timestamp)) return;
    targetSamples.push(cloneJsonValue(sample, label));
    const measuredOffset = Math.max(0, nowRef() - startedAt);
    targetOffsets.push(Math.max(targetOffsets.at(-1) ?? 0, measuredOffset));
  }

  const unsubscribeSource = source.subscribe((sample) => {
    if (destroyed) return;
    if (recording) {
      appendReading(samples, deliveryOffsetsMs, sample, recordingStartedAt, "Raw sensor reading");
    } else {
      appendReading(
        initializationSamples,
        initializationDeliveryOffsetsMs,
        sample,
        initializationStartedAt,
        "Replay initialization reading",
      );
    }
    for (const subscriber of subscribers) subscriber(sample);
  });

  function requestAccess() {
    return source.requestAccess();
  }

  function subscribe(subscriber) {
    if (typeof subscriber !== "function") {
      throw new TypeError("Sensor subscriber must be a function.");
    }
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  function setReplayAction(action) {
    if (destroyed) throw new Error("Cannot initialize a destroyed sensor source.");
    if (recording) throw new Error("Replay initialization must be captured before recording starts.");
    replayAction = action;
    actionSampleCount = initializationSamples.length;
    recordingReplayInitialization = undefined;
  }

  function setReplayCalibration(gravity) {
    if (!gravity || ![gravity.x, gravity.y, gravity.z].every(Number.isFinite)) {
      throw new TypeError("Replay calibration requires finite gravity x, y, and z components.");
    }
    setReplayAction({
      type: REPLAY_INITIALIZATION_ACTION.CALIBRATE,
      gravity: { x: gravity.x, y: gravity.y, z: gravity.z },
    });
  }

  function setReplayWithoutLean() {
    setReplayAction({ type: REPLAY_INITIALIZATION_ACTION.CONTINUE_WITHOUT_LEAN });
  }

  function replayInitialization() {
    if (!replayAction) return undefined;
    return {
      action: replayAction,
      actionSampleCount,
      samples: initializationSamples,
      deliveryOffsetsMs: initializationDeliveryOffsetsMs,
    };
  }

  function startRecording() {
    if (destroyed) throw new Error("Cannot record from a destroyed sensor source.");
    if (!replayAction) {
      throw new Error("A replay initialization action is required before recording starts.");
    }
    samples = [];
    deliveryOffsetsMs = [];
    recordingReplayInitialization = replayInitialization();
    recordingStartedAt = nowRef();
    recording = true;
  }

  function stopRecording() {
    recording = false;
    const log = createRawSensorLog(samples, {
      deliveryOffsetsMs,
      replayInitialization: recordingReplayInitialization,
    });

    // The live estimator keeps consuming sensors between runs. Retain the
    // completed race in the next run's initialization history so a later run
    // from Ready can rebuild the same continuous in-memory estimator state.
    if (replayAction) {
      const raceStartOffset = Math.max(
        initializationDeliveryOffsetsMs.at(-1) ?? 0,
        recordingStartedAt - initializationStartedAt,
      );
      initializationSamples.push(...samples.map((sample) => cloneJsonValue(sample, "Replay history reading")));
      initializationDeliveryOffsetsMs.push(
        ...deliveryOffsetsMs.map((offset) => raceStartOffset + offset),
      );
    }
    return log;
  }

  function getRecording() {
    return createRawSensorLog(samples, {
      deliveryOffsetsMs,
      replayInitialization: recordingReplayInitialization ?? replayInitialization(),
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    recording = false;
    subscribers.clear();
    unsubscribeSource();
    source.destroy?.();
  }

  return Object.freeze({
    requestAccess,
    subscribe,
    destroy,
    setReplayCalibration,
    setReplayWithoutLean,
    startRecording,
    stopRecording,
    getRecording,
    isRecording: () => recording,
  });
}

export function createRawSensorLogFile(log, {
  filename = "trackmaster-raw-sensors.json",
  FileRef = globalThis.File,
  BlobRef = globalThis.Blob,
} = {}) {
  const contents = serializeRawSensorLog(log);
  if (typeof FileRef === "function") {
    return new FileRef([contents], filename, { type: "application/json" });
  }
  if (typeof BlobRef !== "function") throw new Error("File export is unavailable in this browser.");
  const blob = new BlobRef([contents], { type: "application/json" });
  Object.defineProperty(blob, "name", { value: filename, enumerable: true });
  return blob;
}

/**
 * Exports through the share sheet when available, otherwise an in-memory Blob
 * download. Neither path writes application data to a persistent browser
 * store or any other device-side app store.
 */
export async function exportRawSensorLog(log, {
  filename,
  navigatorRef = globalThis.navigator,
  documentRef = globalThis.document,
  URLRef = globalThis.URL,
  setTimeoutRef = globalThis.setTimeout,
  FileRef = globalThis.File,
  BlobRef = globalThis.Blob,
} = {}) {
  const file = createRawSensorLogFile(log, { filename, FileRef, BlobRef });
  const sharePayload = { files: [file], title: "TrackMaster raw sensor log" };

  if (
    typeof navigatorRef?.share === "function" &&
    (typeof navigatorRef.canShare !== "function" || navigatorRef.canShare(sharePayload))
  ) {
    await navigatorRef.share(sharePayload);
    return file;
  }

  if (
    !documentRef?.createElement ||
    typeof URLRef?.createObjectURL !== "function" ||
    typeof URLRef?.revokeObjectURL !== "function"
  ) {
    throw new Error("File export is unavailable in this browser.");
  }

  const url = URLRef.createObjectURL(file);
  let anchor;
  let clickSucceeded = false;
  try {
    anchor = documentRef.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.hidden = true;
    documentRef.body?.append(anchor);
    anchor.click();
    clickSucceeded = true;
    return file;
  } finally {
    try {
      anchor?.remove?.();
    } finally {
      if (!clickSucceeded) {
        URLRef.revokeObjectURL(url);
      } else {
        try {
          setTimeoutRef(() => URLRef.revokeObjectURL(url), 0);
        } catch {
          URLRef.revokeObjectURL(url);
        }
      }
    }
  }
}
