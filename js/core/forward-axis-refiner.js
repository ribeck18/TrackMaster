import {
  cross,
  dot,
  normalize,
} from "./bike-frame.js";

export const DEFAULT_FORWARD_REFINEMENT_OPTIONS = Object.freeze({
  minimumSpeedMps: 12,
  minimumGpsAccelerationMps2: 0.5,
  maximumGpsAccelerationMps2: 8,
  minimumGpsIntervalMs: 250,
  maximumGpsIntervalMs: 1_500,
  maximumGpsAccuracyMetres: 10,
  maximumCourseRateDps: 0.5,
  maximumCourseDeltaDegrees: 0.75,
  maximumCourseConsistencyDegrees: 5,
  maximumVerticalYawRateDps: 0.5,
  minimumMotionSamplesPerInterval: 3,
  minimumAccelerationMps2: 0.5,
  maximumAccelerationMps2: 8,
  accelerationConsistencyFraction: 0.5,
  accelerationConsistencyFloorMps2: 0.35,
  maximumCandidateSpreadDegrees: 2,
  maximumCandidateOutlierDegrees: 8,
  minimumFitIntervals: 3,
  acquisitionWindowIntervals: 6,
  minimumAccelerationExcitationMps2: 1,
  maximumFitResidualMps2: 0.25,
  minimumSlopeMagnitude: 0.65,
  maximumSlopeMagnitude: 1.35,
  revalidationResidualMps2: 0.15,
  minimumUsefulCorrectionDegrees: 5,
  maximumCorrectionDegrees: 35,
  maximumConfidence: 2,
  correctionTimeConstantSeconds: 0.2,
  motionBufferMaximumAgeMs: 3_000,
});

export function wrapDegrees(degrees) {
  if (!Number.isFinite(degrees)) return null;
  return ((degrees + 180) % 360 + 360) % 360 - 180;
}

export function angleDeltaDegrees(next, previous) {
  if (!Number.isFinite(next) || !Number.isFinite(previous)) return null;
  return wrapDegrees(next - previous);
}

function circularMeanDegrees(values) {
  if (values.length === 0) return null;
  const sum = values.reduce(
    (total, value) => {
      const radians = (value * Math.PI) / 180;
      total.sin += Math.sin(radians);
      total.cos += Math.cos(radians);
      return total;
    },
    { sin: 0, cos: 0 },
  );
  if (Math.hypot(sum.sin, sum.cos) < 1e-9) return null;
  return (Math.atan2(sum.sin, sum.cos) * 180) / Math.PI;
}

function circularSpreadDegrees(values) {
  const mean = circularMeanDegrees(values);
  if (mean === null) return Number.POSITIVE_INFINITY;
  return Math.max(...values.map((value) => Math.abs(angleDeltaDegrees(value, mean))));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validateOptions(options) {
  const config = { ...DEFAULT_FORWARD_REFINEMENT_OPTIONS, ...options };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${key} must be a positive finite number.`);
    }
  }
  if (
    config.maximumGpsAccelerationMps2 <= config.minimumGpsAccelerationMps2 ||
    config.maximumGpsIntervalMs <= config.minimumGpsIntervalMs ||
    config.maximumAccelerationMps2 <= config.minimumAccelerationMps2 ||
    config.maximumSlopeMagnitude <= config.minimumSlopeMagnitude ||
    config.maximumCorrectionDegrees <= config.minimumUsefulCorrectionDegrees ||
    !Number.isInteger(config.minimumMotionSamplesPerInterval) ||
    !Number.isInteger(config.minimumFitIntervals) ||
    !Number.isInteger(config.acquisitionWindowIntervals) ||
    config.acquisitionWindowIntervals < config.minimumFitIntervals ||
    !Number.isInteger(config.maximumConfidence)
  ) {
    throw new RangeError("Forward refinement ranges are invalid.");
  }
  return Object.freeze(config);
}

function projectOntoHorizontal(vector, vertical) {
  const alongVertical = dot(vector, vertical);
  return {
    x: vector.x - alongVertical * vertical.x,
    y: vector.y - alongVertical * vertical.y,
    z: vector.z - alongVertical * vertical.z,
  };
}

/** Rotates only the horizontal axes while retaining the captured vertical. */
export function rotateBikeFrame(frame, correctionDegrees) {
  if (!frame?.forward || !frame?.right || !frame?.vertical) {
    throw new TypeError("A captured bike frame is required.");
  }
  if (!Number.isFinite(correctionDegrees)) {
    throw new TypeError("Frame correction must be finite.");
  }
  const radians = (correctionDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const forward = normalize({
    x: frame.forward.x * cosine + frame.right.x * sine,
    y: frame.forward.y * cosine + frame.right.y * sine,
    z: frame.forward.z * cosine + frame.right.z * sine,
  });
  const right = normalize(cross(forward, frame.vertical));
  return Object.freeze({
    forward,
    right,
    vertical: frame.vertical,
    gravityMagnitude: frame.gravityMagnitude,
  });
}

function validLocation(sample, config) {
  return (
    Number.isFinite(sample?.timestamp) &&
    Number.isFinite(sample?.evidenceSpeedMps) &&
    sample.evidenceSpeedMps >= 0 &&
    Number.isFinite(sample?.headingDegrees) &&
    Number.isFinite(sample?.accuracy) &&
    sample.accuracy >= 0 &&
    sample.accuracy <= config.maximumGpsAccuracyMetres
  );
}

/**
 * Pure GPS-bracketed forward-axis estimator. Motion is buffered first and can
 * become evidence only after the following accepted GPS fix proves that exact
 * monotonic-reception interval was straight, fast, and accelerating.
 */
export function createForwardAxisRefiner(frame, {
  nowRef = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now,
  ...options
} = {}) {
  if (!frame?.forward || !frame?.right || !frame?.vertical) {
    throw new TypeError("A captured bike frame is required.");
  }
  const config = validateOptions(options);
  const assumedFrame = rotateBikeFrame(frame, 0);
  let previousLocation = null;
  let latestLocationReceivedAt = null;
  let latestMotionReceivedAt = null;
  let motionBuffer = [];
  let acquisitionIntervals = [];
  let activeFit = null;
  let targetCorrectionDegrees = 0;
  let correctionDegrees = 0;
  let confidence = 0;
  let validatedIntervals = 0;

  function resetBracket(location = null) {
    previousLocation = location;
    motionBuffer = [];
    acquisitionIntervals = [];
  }

  function addMotion(sample, receivedAt = nowRef()) {
    if (
      !Number.isFinite(receivedAt) ||
      (latestMotionReceivedAt !== null && receivedAt < latestMotionReceivedAt)
    ) {
      return snapshot();
    }
    latestMotionReceivedAt = receivedAt;
    const acceleration = sample?.accelerationIncludingGravity;
    const rate = sample?.rotationRate;
    if (
      !acceleration ||
      !rate ||
      ![acceleration.x, acceleration.y, acceleration.z, rate.x, rate.y, rate.z]
        .every(Number.isFinite)
    ) {
      return snapshot();
    }
    const horizontal = projectOntoHorizontal(acceleration, assumedFrame.vertical);
    const rightAcceleration = dot(horizontal, assumedFrame.right);
    const forwardAcceleration = dot(horizontal, assumedFrame.forward);
    const accelerationMagnitude = Math.hypot(rightAcceleration, forwardAcceleration);
    if (accelerationMagnitude < 1e-9) return snapshot();
    // Preserve signed samples through the complete fit. Per-interval polarity
    // folding would turn a fixed intercept into a false changing direction when
    // net forward acceleration crosses zero.
    const angle = (Math.atan2(rightAcceleration, forwardAcceleration) * 180) / Math.PI;
    motionBuffer.push({
      receivedAt,
      angle,
      accelerationMagnitude,
      rightAcceleration,
      forwardAcceleration,
      verticalYawRateDps: dot(rate, assumedFrame.vertical),
    });
    motionBuffer = motionBuffer.filter(
      (reading) => receivedAt - reading.receivedAt <= config.motionBufferMaximumAgeMs,
    );
    return snapshot();
  }

  function qualifyInterval(previous, current) {
    const sourceIntervalMs = current.timestamp - previous.timestamp;
    const receptionIntervalMs = current.receivedAt - previous.receivedAt;
    if (
      sourceIntervalMs < config.minimumGpsIntervalMs ||
      sourceIntervalMs > config.maximumGpsIntervalMs ||
      receptionIntervalMs <= 0 ||
      receptionIntervalMs > config.maximumGpsIntervalMs ||
      previous.evidenceSpeedMps < config.minimumSpeedMps ||
      current.evidenceSpeedMps < config.minimumSpeedMps
    ) {
      return null;
    }

    const elapsedSeconds = sourceIntervalMs / 1_000;
    const gpsAcceleration =
      (current.evidenceSpeedMps - previous.evidenceSpeedMps) / elapsedSeconds;
    const courseDelta = Math.abs(angleDeltaDegrees(
      current.headingDegrees,
      previous.headingDegrees,
    ));
    const courseRate = courseDelta / elapsedSeconds;
    const courseConsistent = [previous, current].every((location) =>
      !Number.isFinite(location.courseHeadingDegrees) ||
      Math.abs(angleDeltaDegrees(location.headingDegrees, location.courseHeadingDegrees)) <=
        config.maximumCourseConsistencyDegrees,
    );
    if (
      gpsAcceleration < config.minimumGpsAccelerationMps2 ||
      gpsAcceleration > config.maximumGpsAccelerationMps2 ||
      courseDelta > config.maximumCourseDeltaDegrees ||
      courseRate > config.maximumCourseRateDps ||
      !courseConsistent
    ) {
      return null;
    }

    const motions = motionBuffer.filter(
      ({ receivedAt }) => receivedAt > previous.receivedAt && receivedAt <= current.receivedAt,
    );
    if (
      motions.length < config.minimumMotionSamplesPerInterval ||
      motions.some(({ verticalYawRateDps }) =>
        Math.abs(verticalYawRateDps) > config.maximumVerticalYawRateDps)
    ) {
      return null;
    }

    const candidateMean = circularMeanDegrees(motions.map(({ angle }) => angle));
    const accepted = candidateMean === null
      ? []
      : motions.filter(({ angle }) =>
        Math.abs(angleDeltaDegrees(angle, candidateMean)) <= config.maximumCandidateOutlierDegrees);
    if (accepted.length < config.minimumMotionSamplesPerInterval) return null;
    const angles = accepted.map(({ angle }) => angle);
    if (circularSpreadDegrees(angles) > config.maximumCandidateSpreadDegrees) return null;

    const measuredAcceleration = median(accepted.map(({ accelerationMagnitude }) => accelerationMagnitude));
    const permittedError = Math.max(
      config.accelerationConsistencyFloorMps2,
      gpsAcceleration * config.accelerationConsistencyFraction,
    );
    if (
      measuredAcceleration < config.minimumAccelerationMps2 ||
      measuredAcceleration > config.maximumAccelerationMps2 ||
      Math.abs(measuredAcceleration - gpsAcceleration) > permittedError
    ) {
      return null;
    }
    return {
      gpsAcceleration,
      rightAcceleration: median(accepted.map((reading) => reading.rightAcceleration)),
      forwardAcceleration: median(accepted.map((reading) => reading.forwardAcceleration)),
    };
  }

  function fitAccelerationAxis(intervals) {
    if (intervals.length < config.minimumFitIntervals) return null;
    const accelerations = intervals.map(({ gpsAcceleration }) => gpsAcceleration);
    const excitation = Math.max(...accelerations) - Math.min(...accelerations);
    if (excitation < config.minimumAccelerationExcitationMps2) return null;
    const meanAcceleration = accelerations.reduce((sum, value) => sum + value, 0) / intervals.length;
    const variance = accelerations.reduce(
      (sum, value) => sum + (value - meanAcceleration) ** 2,
      0,
    );
    if (variance < 1e-9) return null;
    const meanRight = intervals.reduce((sum, value) => sum + value.rightAcceleration, 0) /
      intervals.length;
    const meanForward = intervals.reduce((sum, value) => sum + value.forwardAcceleration, 0) /
      intervals.length;
    const slopeRight = intervals.reduce(
      (sum, value) => sum +
        (value.gpsAcceleration - meanAcceleration) * (value.rightAcceleration - meanRight),
      0,
    ) / variance;
    const slopeForward = intervals.reduce(
      (sum, value) => sum +
        (value.gpsAcceleration - meanAcceleration) * (value.forwardAcceleration - meanForward),
      0,
    ) / variance;
    const interceptRight = meanRight - slopeRight * meanAcceleration;
    const interceptForward = meanForward - slopeForward * meanAcceleration;
    const slopeMagnitude = Math.hypot(slopeRight, slopeForward);
    const residualRms = Math.sqrt(intervals.reduce((sum, value) => {
      const rightError = value.rightAcceleration -
        (interceptRight + slopeRight * value.gpsAcceleration);
      const forwardError = value.forwardAcceleration -
        (interceptForward + slopeForward * value.gpsAcceleration);
      return sum + rightError ** 2 + forwardError ** 2;
    }, 0) / intervals.length);
    if (
      slopeMagnitude < config.minimumSlopeMagnitude ||
      slopeMagnitude > config.maximumSlopeMagnitude ||
      residualRms > config.maximumFitResidualMps2
    ) {
      return null;
    }
    // DeviceMotion implementations may invert the entire acceleration vector.
    // Resolve that polarity once from the fitted changing slope, while keeping
    // the original signed slope/intercept model for residuals and revalidation.
    const polarity = slopeForward < 0 ? -1 : 1;
    return {
      slopeRight,
      slopeForward,
      interceptRight,
      interceptForward,
      polarity,
      correctionDegrees: (Math.atan2(
        slopeRight * polarity,
        slopeForward * polarity,
      ) * 180) / Math.PI,
      residualRms,
      excitation,
    };
  }

  function agreesWithActiveFit(interval) {
    if (!activeFit) return false;
    const predictedRight = activeFit.interceptRight +
      activeFit.slopeRight * interval.gpsAcceleration;
    const predictedForward = activeFit.interceptForward +
      activeFit.slopeForward * interval.gpsAcceleration;
    const rightError = interval.rightAcceleration - predictedRight;
    const forwardError = interval.forwardAcceleration - predictedForward;
    const slopeMagnitude = Math.hypot(activeFit.slopeRight, activeFit.slopeForward);
    // Pitch and throttle-state changes may move the longitudinal intercept.
    // Only disagreement perpendicular to the acquired changing axis is yaw
    // evidence; along-axis intercept movement must not invalidate the frame.
    const perpendicularError = Math.abs(
      rightError * activeFit.slopeForward - forwardError * activeFit.slopeRight,
    ) / slopeMagnitude;
    return perpendicularError <= config.revalidationResidualMps2;
  }

  function acquireReplacement(interval) {
    acquisitionIntervals.push(interval);
    acquisitionIntervals = acquisitionIntervals.slice(-config.acquisitionWindowIntervals);
    const fit = fitAccelerationAxis(acquisitionIntervals);
    if (!fit) return;
    const useful =
      Math.abs(fit.correctionDegrees) >= config.minimumUsefulCorrectionDegrees &&
      Math.abs(fit.correctionDegrees) <= config.maximumCorrectionDegrees;
    if (useful) {
      activeFit = fit;
      targetCorrectionDegrees = fit.correctionDegrees;
      confidence = config.maximumConfidence;
    } else {
      activeFit = null;
      targetCorrectionDegrees = 0;
      confidence = 0;
    }
    acquisitionIntervals = [];
  }

  function recordInterval(interval) {
    validatedIntervals += 1;
    if (!activeFit) {
      acquireReplacement(interval);
      return;
    }
    if (agreesWithActiveFit(interval)) {
      confidence = Math.min(config.maximumConfidence, confidence + 1);
      return;
    }
    confidence -= 1;
    if (confidence <= 0) {
      activeFit = null;
      targetCorrectionDegrees = 0;
      confidence = 0;
      acquisitionIntervals = [interval];
    }
  }

  function addLocation(sample, receivedAt = nowRef()) {
    if (
      !Number.isFinite(receivedAt) ||
      (latestLocationReceivedAt !== null && receivedAt < latestLocationReceivedAt) ||
      !validLocation(sample, config) ||
      (previousLocation !== null && sample.timestamp <= previousLocation.timestamp)
    ) {
      if (Number.isFinite(receivedAt) && !validLocation(sample, config)) resetBracket();
      return snapshot();
    }
    latestLocationReceivedAt = receivedAt;
    const current = {
      timestamp: sample.timestamp,
      receivedAt,
      evidenceSpeedMps: sample.evidenceSpeedMps,
      headingDegrees: wrapDegrees(sample.headingDegrees),
      courseHeadingDegrees: Number.isFinite(sample.courseHeadingDegrees)
        ? wrapDegrees(sample.courseHeadingDegrees)
        : null,
    };
    if (previousLocation !== null) {
      const interval = qualifyInterval(previousLocation, current);
      if (interval !== null) recordInterval(interval);
      else if (!activeFit) acquisitionIntervals = [];
    }
    previousLocation = current;
    motionBuffer = motionBuffer.filter(({ receivedAt: motionAt }) => motionAt > receivedAt);
    return snapshot();
  }

  function clearLocation() {
    latestLocationReceivedAt = null;
    resetBracket();
  }

  function advance(elapsedSeconds) {
    if (Number.isFinite(elapsedSeconds) && elapsedSeconds > 0) {
      const gain = 1 - Math.exp(-elapsedSeconds / config.correctionTimeConstantSeconds);
      correctionDegrees += gain * angleDeltaDegrees(targetCorrectionDegrees, correctionDegrees);
      if (Math.abs(angleDeltaDegrees(targetCorrectionDegrees, correctionDegrees)) < 1e-6) {
        correctionDegrees = targetCorrectionDegrees;
      }
    }
    return rotateBikeFrame(assumedFrame, correctionDegrees);
  }

  function snapshot() {
    return Object.freeze({
      correctionDegrees,
      targetCorrectionDegrees:
        Math.abs(targetCorrectionDegrees) >= config.minimumUsefulCorrectionDegrees
          ? targetCorrectionDegrees
          : null,
      hasTarget: Math.abs(targetCorrectionDegrees) >= config.minimumUsefulCorrectionDegrees,
      confidence,
      validatedIntervals,
      pendingIntervals: acquisitionIntervals.length,
      fitResidualMps2: activeFit?.residualRms ?? null,
      accelerationExcitationMps2: activeFit?.excitation ?? null,
    });
  }

  return Object.freeze({ addLocation, addMotion, clearLocation, advance, snapshot });
}
