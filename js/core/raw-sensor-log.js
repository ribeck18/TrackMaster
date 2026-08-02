import { cloneJsonValue } from "./json-value.js";

export const RAW_SENSOR_LOG_FORMAT = "trackmaster.raw-sensor-log";
export const RAW_SENSOR_LOG_VERSION = 1;

function cloneSample(sample, index) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    throw new TypeError(`Raw sensor sample ${index} must be an object.`);
  }
  if (typeof sample.type !== "string" || sample.type.length === 0) {
    throw new TypeError(`Raw sensor sample ${index} has no type.`);
  }
  if (!Number.isFinite(sample.timestamp)) {
    throw new TypeError(`Raw sensor sample ${index} has no finite timestamp.`);
  }
  return cloneJsonValue(sample, `Raw sensor sample ${index}`);
}

export function createRawSensorLog(samples, { deliveryOffsetsMs } = {}) {
  if (!Array.isArray(samples)) throw new TypeError("Raw sensor samples must be an array.");
  const clonedSamples = samples.map(cloneSample);

  const firstTimestamp = samples[0]?.timestamp ?? 0;
  const offsets = deliveryOffsetsMs ?? samples.map((sample) => Math.max(0, sample.timestamp - firstTimestamp));
  if (!Array.isArray(offsets) || offsets.length !== samples.length) {
    throw new TypeError("Delivery offsets must match the raw sensor sample count.");
  }
  offsets.forEach((offset, index) => {
    if (!Number.isFinite(offset) || offset < 0 || (index > 0 && offset < offsets[index - 1])) {
      throw new RangeError("Delivery offsets must be finite, non-negative, and ordered.");
    }
  });

  return {
    format: RAW_SENSOR_LOG_FORMAT,
    version: RAW_SENSOR_LOG_VERSION,
    samples: clonedSamples,
    deliveryOffsetsMs: [...offsets],
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
  if (value.version !== RAW_SENSOR_LOG_VERSION) {
    throw new RangeError(`Unsupported raw sensor log version: ${value.version}.`);
  }
  return createRawSensorLog(value.samples, { deliveryOffsetsMs: value.deliveryOffsetsMs });
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
