import { cloneJsonValue } from "./json-value.js";
import { createRawSensorLog, serializeRawSensorLog } from "./raw-sensor-log.js";

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

  const unsubscribeSource = source.subscribe((sample) => {
    if (destroyed) return;
    if (recording && Number.isFinite(sample?.timestamp)) {
      samples.push(cloneJsonValue(sample, "Raw sensor reading"));
      const measuredOffset = Math.max(0, nowRef() - recordingStartedAt);
      deliveryOffsetsMs.push(Math.max(deliveryOffsetsMs.at(-1) ?? 0, measuredOffset));
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

  function startRecording() {
    if (destroyed) throw new Error("Cannot record from a destroyed sensor source.");
    samples = [];
    deliveryOffsetsMs = [];
    recordingStartedAt = nowRef();
    recording = true;
  }

  function stopRecording() {
    recording = false;
    return createRawSensorLog(samples, { deliveryOffsetsMs });
  }

  function getRecording() {
    return createRawSensorLog(samples, { deliveryOffsetsMs });
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
