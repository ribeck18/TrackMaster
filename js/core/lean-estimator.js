import {
  captureBikeFrame,
  dot,
  magnitude,
  normalize,
} from "./bike-frame.js";

const GRAVITY_METRES_PER_SECOND_SQUARED = 9.80665;
const MPH_TO_METRES_PER_SECOND = 0.44704;

export const LEAN_ESTIMATOR_INTERFACE = Object.freeze([
  "calibrate",
  "update",
  "clearLocation",
  "snapshot",
]);

export const DEFAULT_LEAN_ESTIMATOR_OPTIONS = Object.freeze({
  gravity: GRAVITY_METRES_PER_SECOND_SQUARED,
  maximumLeanDegrees: 60,
  kinematicTrustStartMps: 10 * MPH_TO_METRES_PER_SECOND,
  kinematicTrustFullMps: 15 * MPH_TO_METRES_PER_SECOND,
  fusionTimeConstantSeconds: 0.8,
  kinematicRollSuppressionStartDps: 1,
  kinematicRollSuppressionFullDps: 3,
  biasTimeConstantSeconds: 2,
  stationaryRateThresholdDps: 0.8,
  stationaryGravityTolerance: 0.12,
  stationaryVerticalCosine: Math.cos((8 * Math.PI) / 180),
  maximumIntegrationStepSeconds: 0.1,
  uprightCorrectionTimeConstantSeconds: 2.5,
  locationTrustMaximumAgeMs: 2_000,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(value) {
  const bounded = clamp(value, 0, 1);
  return bounded * bounded * (3 - 2 * bounded);
}

function gravityVector(sample) {
  const gravity = sample?.accelerationIncludingGravity;
  if (
    !gravity ||
    !Number.isFinite(gravity.x) ||
    !Number.isFinite(gravity.y) ||
    !Number.isFinite(gravity.z)
  ) {
    return null;
  }
  return { x: gravity.x, y: gravity.y, z: gravity.z };
}

function angularVelocityVector(sample) {
  const rate = sample?.rotationRate;
  if (!rate || ![rate.x, rate.y, rate.z].every(Number.isFinite)) return null;
  return { x: rate.x, y: rate.y, z: rate.z };
}

function validateOptions(options) {
  const merged = { ...DEFAULT_LEAN_ESTIMATOR_OPTIONS, ...options };
  for (const key of [
    "gravity",
    "maximumLeanDegrees",
    "fusionTimeConstantSeconds",
    "kinematicRollSuppressionStartDps",
    "kinematicRollSuppressionFullDps",
    "biasTimeConstantSeconds",
    "stationaryRateThresholdDps",
    "stationaryGravityTolerance",
    "maximumIntegrationStepSeconds",
    "uprightCorrectionTimeConstantSeconds",
    "locationTrustMaximumAgeMs",
  ]) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) {
      throw new RangeError(`${key} must be a positive finite number.`);
    }
  }
  if (merged.kinematicRollSuppressionFullDps <= merged.kinematicRollSuppressionStartDps) {
    throw new RangeError("Kinematic roll suppression rates must define an increasing range.");
  }
  if (
    !Number.isFinite(merged.kinematicTrustStartMps) ||
    !Number.isFinite(merged.kinematicTrustFullMps) ||
    merged.kinematicTrustStartMps < 0 ||
    merged.kinematicTrustFullMps <= merged.kinematicTrustStartMps
  ) {
    throw new RangeError("Kinematic trust speeds must define an increasing non-negative range.");
  }
  return Object.freeze(merged);
}

/**
 * Pure, stateful complementary lean estimator. It consumes raw sample objects
 * and has no browser or DOM dependency, so another implementation can replace
 * it anywhere the exported interface is honored.
 */
export function createLeanEstimator(options = {}) {
  const {
    nowRef = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now,
    ...estimatorOptions
  } = options;
  const config = validateOptions(estimatorOptions);
  let frame = null;
  let leanDegrees = 0;
  let rollBiasDps = 0;
  let speedMps = null;
  let lastLocationTimestamp = null;
  let lastLocationReceivedAt = null;
  let lastMotionTimestamp = null;
  let lastKinematicDegrees = null;

  function calibrate(sampleOrGravity) {
    const vector = gravityVector(sampleOrGravity) ?? sampleOrGravity;
    frame = captureBikeFrame(
      vector,
      estimatorOptions.assumedForwardAxis
        ? { assumedForwardAxis: estimatorOptions.assumedForwardAxis }
        : undefined,
    );
    leanDegrees = 0;
    rollBiasDps = 0;
    lastMotionTimestamp = null;
    lastKinematicDegrees = null;
    return frame;
  }

  function updateLocation(sample) {
    if (
      !Number.isFinite(sample.timestamp) ||
      (lastLocationTimestamp !== null && sample.timestamp <= lastLocationTimestamp)
    ) {
      return snapshot();
    }
    lastLocationTimestamp = sample.timestamp;
    if (Number.isFinite(sample.speedMps) && sample.speedMps >= 0) {
      speedMps = sample.speedMps;
      lastLocationReceivedAt = nowRef();
    } else {
      speedMps = null;
      lastLocationReceivedAt = null;
    }
    return snapshot();
  }

  function hasFreshLocation(now = nowRef()) {
    return (
      speedMps !== null &&
      lastLocationReceivedAt !== null &&
      Number.isFinite(now) &&
      now - lastLocationReceivedAt <= config.locationTrustMaximumAgeMs
    );
  }

  function updateMotion(sample) {
    if (!frame || !Number.isFinite(sample.timestamp)) return snapshot();
    const angularVelocity = angularVelocityVector(sample);
    if (!angularVelocity) return snapshot();

    if (lastMotionTimestamp === null) {
      lastMotionTimestamp = sample.timestamp;
      return snapshot();
    }

    const elapsedSeconds = (sample.timestamp - lastMotionTimestamp) / 1_000;
    if (elapsedSeconds <= 0) return snapshot();
    lastMotionTimestamp = sample.timestamp;
    const dt = Math.min(elapsedSeconds, config.maximumIntegrationStepSeconds);

    // With right × forward = vertical, positive rotation around forward tips
    // vertical toward bike-right. Device yaw has the opposite sign to compass
    // heading, hence the minus on yaw rate.
    const rollRateDps = dot(angularVelocity, frame.forward);
    const rightRateDps = dot(angularVelocity, frame.right);
    const verticalRateDps = dot(angularVelocity, frame.vertical);
    const leanRadians = (leanDegrees * Math.PI) / 180;
    // A world-vertical yaw vector resolves in the leaned body frame as
    // +right·sin(lean) - vertical·cos(lean) for a positive/right turn. Taking
    // that unit-vector projection avoids the singular division by cos(lean).
    const yawRateDps =
      rightRateDps * Math.sin(leanRadians) - verticalRateDps * Math.cos(leanRadians);

    const measuredGravity = gravityVector(sample);
    if (measuredGravity) {
      const measuredMagnitude = magnitude(measuredGravity);
      const magnitudeError = Math.abs(measuredMagnitude - frame.gravityMagnitude) / frame.gravityMagnitude;
      const alignment = dot(normalize(measuredGravity), frame.vertical);
      const stationary =
        Math.abs(rollRateDps) <= config.stationaryRateThresholdDps &&
        Math.abs(yawRateDps) <= config.stationaryRateThresholdDps &&
        magnitudeError <= config.stationaryGravityTolerance &&
        alignment >= config.stationaryVerticalCosine;
      if (stationary) {
        const biasGain = 1 - Math.exp(-dt / config.biasTimeConstantSeconds);
        rollBiasDps += biasGain * (rollRateDps - rollBiasDps);
        const uprightGain = 1 - Math.exp(-dt / config.uprightCorrectionTimeConstantSeconds);
        leanDegrees += uprightGain * (0 - leanDegrees);
      }
    }

    leanDegrees += (rollRateDps - rollBiasDps) * dt;
    lastKinematicDegrees = null;

    if (hasFreshLocation()) {
      const trustPosition =
        (speedMps - config.kinematicTrustStartMps) /
        (config.kinematicTrustFullMps - config.kinematicTrustStartMps);
      const speedTrust = smoothstep(trustPosition);
      // The kinematic estimate naturally lags tip-in. Suppress its correction
      // while roll motion is active so the fast gyro path is not pulled back
      // toward upright before yaw has developed.
      const rollSuppressionPosition =
        (Math.abs(rollRateDps - rollBiasDps) - config.kinematicRollSuppressionStartDps) /
        (config.kinematicRollSuppressionFullDps - config.kinematicRollSuppressionStartDps);
      const trust = speedTrust * (1 - smoothstep(rollSuppressionPosition));
      if (trust > 0) {
        const yawRateRadians = (yawRateDps * Math.PI) / 180;
        lastKinematicDegrees =
          (Math.atan((speedMps * yawRateRadians) / config.gravity) * 180) / Math.PI;
        const correctionGain = trust * (1 - Math.exp(-dt / config.fusionTimeConstantSeconds));
        leanDegrees += correctionGain * (lastKinematicDegrees - leanDegrees);
      }
    }

    leanDegrees = clamp(leanDegrees, -config.maximumLeanDegrees, config.maximumLeanDegrees);
    return snapshot();
  }

  function update(sample) {
    if (sample?.type === "location") return updateLocation(sample);
    if (sample?.type === "motion") return updateMotion(sample);
    return snapshot();
  }

  function clearLocation() {
    speedMps = null;
    lastLocationTimestamp = null;
    lastLocationReceivedAt = null;
    lastKinematicDegrees = null;
  }

  function snapshot() {
    return Object.freeze({
      calibrated: frame !== null,
      leanDegrees,
      direction: Math.abs(leanDegrees) < 1 ? "LEVEL" : leanDegrees < 0 ? "LEFT" : "RIGHT",
      hasLocation: hasFreshLocation(),
      kinematicDegrees: lastKinematicDegrees,
    });
  }

  return Object.freeze({ calibrate, update, clearLocation, snapshot });
}

export function isGyroDeliveryFresh(lastReceivedAt, now, maximumAgeMs = 1_000) {
  return (
    Number.isFinite(lastReceivedAt) &&
    Number.isFinite(now) &&
    Number.isFinite(maximumAgeMs) &&
    maximumAgeMs > 0 &&
    now - lastReceivedAt >= 0 &&
    now - lastReceivedAt <= maximumAgeMs
  );
}

export function assertLeanEstimator(estimator) {
  for (const method of LEAN_ESTIMATOR_INTERFACE) {
    if (typeof estimator?.[method] !== "function") {
      throw new TypeError(`LeanEstimator must implement ${method}().`);
    }
  }
  return estimator;
}
