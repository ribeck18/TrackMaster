import { cloneJsonValue } from "./json-value.js";

export const RAW_SENSOR_LOG_FORMAT = "trackmaster.raw-sensor-log";
export const RAW_SENSOR_LOG_LEGACY_VERSION = 1;
export const RAW_SENSOR_LOG_VERSION = 2;
export const REPLAY_INITIALIZATION_ACTION = Object.freeze({
  CALIBRATE: "calibrate",
  CONTINUE_WITHOUT_LEAN: "continue-without-lean",
});

function cloneSample(sample, index, label = "Raw sensor sample") {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    throw new TypeError(`${label} ${index} must be an object.`);
  }
  if (typeof sample.type !== "string" || sample.type.length === 0) {
    throw new TypeError(`${label} ${index} has no type.`);
  }
  if (!Number.isFinite(sample.timestamp)) {
    throw new TypeError(`${label} ${index} has no finite timestamp.`);
  }
  return cloneJsonValue(sample, `${label} ${index}`);
}

function cloneOffsets(offsets, sampleCount, label) {
  if (!Array.isArray(offsets) || offsets.length !== sampleCount) {
    throw new TypeError(`${label} must match the raw sensor sample count.`);
  }
  offsets.forEach((offset, index) => {
    if (!Number.isFinite(offset) || offset < 0 || (index > 0 && offset < offsets[index - 1])) {
      throw new RangeError(`${label} must be finite, non-negative, and ordered.`);
    }
  });
  return [...offsets];
}

function cloneInitializationAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new TypeError("Replay initialization action must be an object.");
  }
  if (action.type === REPLAY_INITIALIZATION_ACTION.CONTINUE_WITHOUT_LEAN) {
    return { type: action.type };
  }
  if (action.type !== REPLAY_INITIALIZATION_ACTION.CALIBRATE) {
    throw new TypeError(`Unsupported replay initialization action: ${action.type}.`);
  }
  const gravity = action.gravity;
  if (!gravity || ![gravity.x, gravity.y, gravity.z].every(Number.isFinite)) {
    throw new TypeError("Replay calibration action must contain finite gravity x, y, and z components.");
  }
  if (Math.hypot(gravity.x, gravity.y, gravity.z) === 0) {
    throw new RangeError("Replay calibration gravity must have a non-zero magnitude.");
  }
  return {
    type: action.type,
    gravity: { x: gravity.x, y: gravity.y, z: gravity.z },
  };
}

function cloneReplayInitialization(initialization) {
  if (!initialization || typeof initialization !== "object" || Array.isArray(initialization)) {
    throw new TypeError("Version 2 raw logs require replay initialization metadata.");
  }
  if (!Array.isArray(initialization.samples)) {
    throw new TypeError("Replay initialization samples must be an array.");
  }
  const samples = initialization.samples.map((sample, index) =>
    cloneSample(sample, index, "Replay initialization sample"),
  );
  if (
    !Number.isInteger(initialization.actionSampleCount) ||
    initialization.actionSampleCount < 0 ||
    initialization.actionSampleCount > samples.length
  ) {
    throw new RangeError("Replay action sample count must be an integer within initialization samples.");
  }
  return {
    action: cloneInitializationAction(initialization.action),
    actionSampleCount: initialization.actionSampleCount,
    samples,
    deliveryOffsetsMs: cloneOffsets(
      initialization.deliveryOffsetsMs,
      samples.length,
      "Replay initialization delivery offsets",
    ),
  };
}

function createBaseLog(samples, deliveryOffsetsMs, version) {
  if (!Array.isArray(samples)) throw new TypeError("Raw sensor samples must be an array.");
  const clonedSamples = samples.map((sample, index) => cloneSample(sample, index));
  const firstTimestamp = samples[0]?.timestamp ?? 0;
  const offsets = deliveryOffsetsMs ?? samples.map((sample) =>
    Math.max(0, sample.timestamp - firstTimestamp));
  return {
    format: RAW_SENSOR_LOG_FORMAT,
    version,
    samples: clonedSamples,
    deliveryOffsetsMs: cloneOffsets(offsets, samples.length, "Delivery offsets"),
  };
}

export function createRawSensorLog(samples, {
  version = RAW_SENSOR_LOG_VERSION,
  deliveryOffsetsMs,
  replayInitialization,
} = {}) {
  if (version === RAW_SENSOR_LOG_LEGACY_VERSION) {
    return createBaseLog(samples, deliveryOffsetsMs, version);
  }
  if (version !== RAW_SENSOR_LOG_VERSION) {
    throw new RangeError(`Unsupported raw sensor log version: ${version}.`);
  }
  return {
    ...createBaseLog(samples, deliveryOffsetsMs, version),
    replayInitialization: cloneReplayInitialization(replayInitialization),
  };
}

export function serializeRawSensorLog(log) {
  return `${JSON.stringify(validateRawSensorLog(log), null, 2)}\n`;
}

export function validateRawSensorLog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Raw sensor log must be an object.");
  }
  if (value.format !== RAW_SENSOR_LOG_FORMAT) {
    throw new TypeError("Unsupported raw sensor log format.");
  }
  if (value.version === RAW_SENSOR_LOG_LEGACY_VERSION) {
    return createRawSensorLog(value.samples, {
      version: RAW_SENSOR_LOG_LEGACY_VERSION,
      deliveryOffsetsMs: value.deliveryOffsetsMs,
    });
  }
  if (value.version === RAW_SENSOR_LOG_VERSION) {
    return createRawSensorLog(value.samples, {
      version: RAW_SENSOR_LOG_VERSION,
      deliveryOffsetsMs: value.deliveryOffsetsMs,
      replayInitialization: value.replayInitialization,
    });
  }
  throw new RangeError(`Unsupported raw sensor log version: ${value.version}.`);
}

/** Load from a parsed object, JSON text, Blob, or File. */
export async function loadRawSensorLog(input) {
  let value = input;
  if (input && typeof input.text === "function") value = await input.text();
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new SyntaxError(`Invalid raw sensor log JSON: ${error.message}`);
    }
  }
  return validateRawSensorLog(value);
}
