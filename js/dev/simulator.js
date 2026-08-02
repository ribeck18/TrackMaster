import { createTimedSensorSource } from "../sensors/timed-sensor-source.js";

const MPH_TO_METRES_PER_SECOND = 0.44704;
const METRES_PER_DEGREE_LATITUDE = 111_320;

export const SYNTHETIC_SCENARIOS = Object.freeze({
  lowSpeedManoeuvring: Object.freeze({ start: 0, end: 3_900 }),
  sustainedCorner: Object.freeze({ start: 8_000, end: 13_900 }),
  uprightHardBraking: Object.freeze({ start: 18_000, end: 21_000 }),
  secondLowSpeedManoeuvring: Object.freeze({ start: 21_100, end: 23_900 }),
  sustainedOppositeCorner: Object.freeze({ start: 28_000, end: 33_900 }),
});

function interpolate(start, end, progress) {
  return start + (end - start) * progress;
}

function stateAt(timestamp) {
  if (timestamp < 4_000) {
    return { speedMph: 8, heading: interpolate(330, 390, timestamp / 4_000), roll: 7, pitch: 1 };
  }
  if (timestamp < 8_000) {
    const progress = (timestamp - 4_000) / 4_000;
    return { speedMph: interpolate(8, 55, progress), heading: 30, roll: 0, pitch: -5 };
  }
  if (timestamp < 14_000) {
    const progress = (timestamp - 8_000) / 6_000;
    return { speedMph: 55, heading: interpolate(30, 120, progress), roll: 38, pitch: 0 };
  }
  if (timestamp < 18_000) {
    const progress = (timestamp - 14_000) / 4_000;
    return { speedMph: interpolate(55, 85, progress), heading: 120, roll: 0, pitch: -3 };
  }
  if (timestamp <= 21_000) {
    const progress = (timestamp - 18_000) / 3_000;
    return { speedMph: interpolate(85, 12, progress), heading: 120, roll: 0, pitch: 12 };
  }
  if (timestamp < 24_000) {
    const progress = (timestamp - 21_000) / 3_000;
    return { speedMph: 10, heading: interpolate(120, 180, progress), roll: -8, pitch: 0 };
  }
  if (timestamp < 28_000) {
    const progress = (timestamp - 24_000) / 4_000;
    return {
      speedMph: interpolate(10, 50, progress),
      heading: 180,
      roll: interpolate(-8, -35, progress),
      pitch: -4,
    };
  }
  if (timestamp < 34_000) {
    const progress = (timestamp - 28_000) / 6_000;
    return { speedMph: 50, heading: interpolate(180, 90, progress), roll: -35, pitch: 0 };
  }
  const progress = Math.min(1, (timestamp - 34_000) / 4_000);
  return { speedMph: interpolate(50, 5, progress), heading: 90, roll: 0, pitch: 3 };
}

function normalizeHeading(degrees) {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Builds the exact raw readings emitted by the desk simulator. There is no
 * randomness or wall-clock input, so separate runs produce byte-for-byte equal
 * sample arrays.
 */
export function createSyntheticSessionSamples({ durationMs = 38_000 } = {}) {
  if (!Number.isInteger(durationMs) || durationMs < 34_000) {
    throw new RangeError("Synthetic sessions must include the complete 34 second scenario set.");
  }

  const samples = [];
  let latitude = 37.4219999;
  let longitude = -122.0840575;
  let previousLocationTimestamp = 0;

  for (let timestamp = 0; timestamp <= durationMs; timestamp += 100) {
    const state = stateAt(timestamp);

    if (timestamp % 500 === 0) {
      if (timestamp > 0) {
        const elapsedSeconds = (timestamp - previousLocationTimestamp) / 1_000;
        const distance = state.speedMph * MPH_TO_METRES_PER_SECOND * elapsedSeconds;
        const headingRadians = (normalizeHeading(state.heading) * Math.PI) / 180;
        latitude += (Math.cos(headingRadians) * distance) / METRES_PER_DEGREE_LATITUDE;
        longitude +=
          (Math.sin(headingRadians) * distance) /
          (METRES_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180));
      }
      previousLocationTimestamp = timestamp;
      samples.push({
        type: "location",
        timestamp,
        latitude,
        longitude,
        accuracy: 3,
        speed: state.speedMph * MPH_TO_METRES_PER_SECOND,
        heading: normalizeHeading(state.heading),
      });
    }

    samples.push({
      type: "orientation",
      timestamp,
      alpha: normalizeHeading(state.heading),
      beta: state.pitch,
      gamma: state.roll,
    });
  }

  return samples;
}

export function createSyntheticSensorSource(options = {}) {
  const { samples = createSyntheticSessionSamples(), playbackRate = 1, loop = true, ...timing } = options;
  return createTimedSensorSource(samples, { playbackRate, loop, ...timing });
}
