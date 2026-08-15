import { createTimedSensorSource } from "../sensors/timed-sensor-source.js";

const MPH_TO_METRES_PER_SECOND = 0.44704;
const METRES_PER_DEGREE_LATITUDE = 111_320;
const GRAVITY_METRES_PER_SECOND_SQUARED = 9.80665;

function equilibriumLean(speedMph, headingRateDegreesPerSecond) {
  const yawRate = (headingRateDegreesPerSecond * Math.PI) / 180;
  return (Math.atan((speedMph * MPH_TO_METRES_PER_SECOND * yawRate) / GRAVITY_METRES_PER_SECOND_SQUARED) * 180) / Math.PI;
}

const FIRST_CORNER_LEAN = equilibriumLean(55, 15);
const SECOND_CORNER_LEAN = equilibriumLean(50, -15);

export const SYNTHETIC_SCENARIOS = Object.freeze({
  lowSpeedManoeuvring: Object.freeze({ start: 0, end: 3_900 }),
  firstStraight: Object.freeze({ start: 4_000, end: 7_900 }),
  sustainedCorner: Object.freeze({ start: 8_500, end: 14_400, trueLeanDegrees: FIRST_CORNER_LEAN }),
  uprightHardBraking: Object.freeze({ start: 18_000, end: 21_000 }),
  secondLowSpeedManoeuvring: Object.freeze({ start: 21_100, end: 23_900 }),
  sustainedOppositeCorner: Object.freeze({ start: 28_000, end: 33_900, trueLeanDegrees: SECOND_CORNER_LEAN }),
});

function interpolate(start, end, progress) {
  return start + (end - start) * progress;
}

function stateAt(timestamp) {
  if (timestamp < 2_000) {
    return { speedMph: 0, heading: 330, roll: 0, pitch: 0 };
  }
  if (timestamp < 4_000) {
    const progress = (timestamp - 2_000) / 2_000;
    return { speedMph: 8, heading: interpolate(330, 390, progress), roll: 7, pitch: 1 };
  }
  if (timestamp < 6_000) {
    const progress = (timestamp - 4_000) / 2_000;
    return { speedMph: interpolate(8, 35, progress), heading: 30, roll: 0, pitch: -5 };
  }
  if (timestamp < 8_000) {
    const progress = (timestamp - 6_000) / 2_000;
    return { speedMph: interpolate(35, 55, progress), heading: 30, roll: 0, pitch: -5 };
  }
  if (timestamp < 8_500) {
    const progress = (timestamp - 8_000) / 500;
    return {
      speedMph: 55,
      heading: interpolate(30, 37.5, progress),
      roll: interpolate(0, FIRST_CORNER_LEAN, progress),
      pitch: 0,
    };
  }
  if (timestamp < 14_500) {
    const progress = (timestamp - 8_500) / 6_000;
    return { speedMph: 55, heading: interpolate(37.5, 127.5, progress), roll: FIRST_CORNER_LEAN, pitch: 0 };
  }
  if (timestamp < 15_000) {
    const progress = (timestamp - 14_500) / 500;
    return { speedMph: 55, heading: 127.5, roll: interpolate(FIRST_CORNER_LEAN, 0, progress), pitch: 0 };
  }
  if (timestamp < 18_000) {
    const progress = (timestamp - 15_000) / 3_000;
    return { speedMph: interpolate(55, 85, progress), heading: 127.5, roll: 0, pitch: -3 };
  }
  if (timestamp <= 21_000) {
    const progress = (timestamp - 18_000) / 3_000;
    return { speedMph: interpolate(85, 12, progress), heading: 127.5, roll: 0, pitch: 12 };
  }
  if (timestamp < 24_000) {
    const progress = (timestamp - 21_000) / 3_000;
    return { speedMph: 10, heading: interpolate(127.5, 180, progress), roll: -8, pitch: 0 };
  }
  if (timestamp < 28_000) {
    const progress = (timestamp - 24_000) / 4_000;
    return {
      speedMph: interpolate(10, 50, progress),
      heading: 180,
      roll: interpolate(-8, SECOND_CORNER_LEAN, progress),
      pitch: -4,
    };
  }
  if (timestamp < 34_000) {
    const progress = (timestamp - 28_000) / 6_000;
    return { speedMph: 50, heading: interpolate(180, 90, progress), roll: SECOND_CORNER_LEAN, pitch: 0 };
  }
  if (timestamp < 35_000) {
    const progress = (timestamp - 34_000) / 1_000;
    return {
      speedMph: interpolate(50, 38.75, progress),
      heading: 90,
      roll: interpolate(SECOND_CORNER_LEAN, 0, progress),
      pitch: 3,
    };
  }
  const progress = Math.min(1, (timestamp - 35_000) / 3_000);
  return { speedMph: interpolate(38.75, 5, progress), heading: 90, roll: 0, pitch: 3 };
}

function normalizeHeading(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function headingDelta(next, previous) {
  return ((next - previous + 540) % 360) - 180;
}

function pitchBikeVector(vector, pitchDegrees) {
  const radians = (pitchDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: vector.x,
    y: vector.y * cosine + vector.z * sine,
    z: -vector.y * sine + vector.z * cosine,
  };
}

function yawTwistBikeVector(vector, mountYawDegrees) {
  const radians = (mountYawDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: vector.x * cosine + vector.y * sine,
    y: -vector.x * sine + vector.y * cosine,
    z: vector.z,
  };
}

/**
 * Builds the exact raw readings emitted by the desk simulator. There is no
 * randomness or wall-clock input, so separate runs produce byte-for-byte equal
 * sample arrays.
 */
export function createSyntheticSessionSamples({
  durationMs = 38_000,
  mountYawDegrees = 0,
} = {}) {
  if (!Number.isInteger(durationMs) || durationMs < 34_000) {
    throw new RangeError("Synthetic sessions must include the complete 34 second scenario set.");
  }
  if (!Number.isFinite(mountYawDegrees) || Math.abs(mountYawDegrees) > 45) {
    throw new RangeError("Synthetic mount yaw must be finite and no more than 45 degrees.");
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

    const previousState = timestamp === 0 ? state : stateAt(timestamp - 100);
    const elapsedSeconds = 0.1;
    const rollRate = timestamp === 0 ? 0 : (state.roll - previousState.roll) / elapsedSeconds;
    const pitchRate = timestamp === 0 ? 0 : (state.pitch - previousState.pitch) / elapsedSeconds;
    const yawRate = timestamp === 0 ? 0 : headingDelta(state.heading, previousState.heading) / elapsedSeconds;
    const longitudinalAcceleration =
      timestamp === 0
        ? 0
        : ((state.speedMph - previousState.speedMph) * MPH_TO_METRES_PER_SECOND) / elapsedSeconds;
    const effectiveVerticalGravity =
      GRAVITY_METRES_PER_SECOND_SQUARED / Math.cos((state.roll * Math.PI) / 180);

    const leanRadians = (state.roll * Math.PI) / 180;
    // Normalized device-body gyro. A positive compass/right yaw is a rotation
    // about -world-up, which resolves into leaned body right/vertical axes.
    samples.push({
      type: "motion",
      timestamp,
      accelerationIncludingGravity: yawTwistBikeVector(pitchBikeVector({
        x: 0,
        y: longitudinalAcceleration,
        z: effectiveVerticalGravity,
      }, state.pitch), mountYawDegrees),
      rotationRate: yawTwistBikeVector({
        x: pitchRate + yawRate * Math.sin(leanRadians),
        y: rollRate,
        z: -yawRate * Math.cos(leanRadians),
      }, mountYawDegrees),
      interval: 100,
    });
  }

  return samples;
}

export function createSyntheticSensorSource(options = {}) {
  const { samples = createSyntheticSessionSamples(), playbackRate = 1, loop = true, ...timing } = options;
  return createTimedSensorSource(samples, { playbackRate, loop, ...timing });
}
