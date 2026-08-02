import { loadRawSensorLog, validateRawSensorLog } from "../core/raw-sensor-log.js";
import { createTimedSensorSource } from "../sensors/timed-sensor-source.js";

/** Replay a validated log without changing timestamps or reading values. */
export function createReplaySensorSource(log, options = {}) {
  const validated = validateRawSensorLog(log);
  return createTimedSensorSource(validated.samples, {
    loop: false,
    deliveryOffsetsMs: validated.deliveryOffsetsMs,
    ...options,
  });
}

/** Load JSON text/File/Blob and return a source on the unified sensor seam. */
export async function loadReplaySensorSource(input, options = {}) {
  const log = await loadRawSensorLog(input);
  return createReplaySensorSource(log, options);
}
