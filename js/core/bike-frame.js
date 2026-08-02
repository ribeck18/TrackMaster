const EPSILON = 1e-9;

function finiteVector(vector, label) {
  if (
    !vector ||
    !Number.isFinite(vector.x) ||
    !Number.isFinite(vector.y) ||
    !Number.isFinite(vector.z)
  ) {
    throw new TypeError(`${label} must contain finite x, y, and z components.`);
  }
  return { x: vector.x, y: vector.y, z: vector.z };
}

export function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

export function magnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

export function normalize(vector, label = "Vector") {
  const owned = finiteVector(vector, label);
  const length = magnitude(owned);
  if (length < EPSILON) throw new RangeError(`${label} must have a non-zero magnitude.`);
  return Object.freeze({
    x: owned.x / length,
    y: owned.y / length,
    z: owned.z / length,
  });
}

/**
 * Captures an orthonormal bike frame in device coordinates.
 *
 * accelerationIncludingGravity points along the support/up direction on the
 * browser sensor API while the phone is stationary. That complete 3-vector is
 * retained as bike vertical. Per issue #5, forward-axis refinement belongs to
 * issue #6: for now the configured mount axis (the phone's long +Y axis) is
 * projected onto the plane normal to vertical.
 */
export function captureBikeFrame(gravityVector, {
  assumedForwardAxis = Object.freeze({ x: 0, y: 1, z: 0 }),
} = {}) {
  const vertical = normalize(gravityVector, "Gravity vector");
  const mountForward = normalize(assumedForwardAxis, "Assumed mount axis");
  const parallel = dot(mountForward, vertical);
  const projectedForward = {
    x: mountForward.x - parallel * vertical.x,
    y: mountForward.y - parallel * vertical.y,
    z: mountForward.z - parallel * vertical.z,
  };
  if (magnitude(projectedForward) < 0.05) {
    throw new RangeError("The assumed mount axis is too close to vertical to resolve a bike frame.");
  }

  const forward = normalize(projectedForward, "Projected mount axis");
  // right × forward = up. This convention makes positive lean a right lean.
  const right = normalize(cross(forward, vertical), "Bike right axis");

  return Object.freeze({
    forward,
    right,
    vertical,
    gravityMagnitude: magnitude(gravityVector),
  });
}

export function projectDeviceVector(vector, frame) {
  const owned = finiteVector(vector, "Device vector");
  if (!frame?.forward || !frame?.right || !frame?.vertical) {
    throw new TypeError("A captured bike frame is required.");
  }
  return Object.freeze({
    forward: dot(owned, frame.forward),
    right: dot(owned, frame.right),
    vertical: dot(owned, frame.vertical),
  });
}

const DEFAULT_CALIBRATION_OPTIONS = Object.freeze({
  windowMs: 600,
  minimumSpanMs: 400,
  minimumSamples: 5,
  maximumAgeMs: 300,
  minimumGravity: 8.8,
  maximumGravity: 10.8,
  maximumRateDps: 3,
  maximumDirectionSpreadDegrees: 3,
});

function motionGravity(sample) {
  const gravity = sample?.accelerationIncludingGravity;
  if (!gravity || ![gravity.x, gravity.y, gravity.z].every(Number.isFinite)) return null;
  return { x: gravity.x, y: gravity.y, z: gravity.z };
}

function motionRate(sample) {
  const rate = sample?.rotationRate;
  if (!rate || ![rate.x, rate.y, rate.z].every(Number.isFinite)) return null;
  return { x: rate.x, y: rate.y, z: rate.z };
}

/** Collects a recent, stable gravity+gyro window for ZERO. */
export function createBikeFrameCalibrationWindow({
  nowRef = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now,
  ...overrides
} = {}) {
  const config = Object.freeze({ ...DEFAULT_CALIBRATION_OPTIONS, ...overrides });
  const positiveKeys = [
    "windowMs",
    "minimumSpanMs",
    "minimumSamples",
    "maximumAgeMs",
    "minimumGravity",
    "maximumGravity",
    "maximumRateDps",
    "maximumDirectionSpreadDegrees",
  ];
  if (positiveKeys.some((key) => !Number.isFinite(config[key]) || config[key] <= 0)) {
    throw new RangeError("Calibration window limits must be positive finite numbers.");
  }
  if (config.maximumGravity <= config.minimumGravity || config.minimumSpanMs > config.windowMs) {
    throw new RangeError("Calibration window ranges are invalid.");
  }

  let readings = [];

  function add(sample, receivedAt = nowRef()) {
    const gravity = motionGravity(sample);
    const rate = motionRate(sample);
    const gravityMagnitude = gravity ? magnitude(gravity) : 0;
    const valid =
      Number.isFinite(receivedAt) &&
      gravity &&
      rate &&
      gravityMagnitude >= config.minimumGravity &&
      gravityMagnitude <= config.maximumGravity &&
      magnitude(rate) <= config.maximumRateDps;

    if (!valid) {
      readings = [];
      return snapshot(receivedAt);
    }

    readings.push({ receivedAt, gravity, direction: normalize(gravity) });
    readings = readings.filter((reading) => receivedAt - reading.receivedAt <= config.windowMs);
    return snapshot(receivedAt);
  }

  function snapshot(now = nowRef()) {
    if (!Number.isFinite(now) || readings.length === 0) {
      return Object.freeze({ ready: false, reason: "WAITING FOR MOTION", gravity: null });
    }
    const latest = readings.at(-1);
    if (now - latest.receivedAt > config.maximumAgeMs) {
      return Object.freeze({ ready: false, reason: "MOTION SAMPLE STALE", gravity: null });
    }
    const span = latest.receivedAt - readings[0].receivedAt;
    if (readings.length < config.minimumSamples || span < config.minimumSpanMs) {
      return Object.freeze({ ready: false, reason: "HOLD BIKE UPRIGHT & STILL", gravity: null });
    }

    const sum = readings.reduce(
      (total, reading) => ({
        x: total.x + reading.gravity.x,
        y: total.y + reading.gravity.y,
        z: total.z + reading.gravity.z,
      }),
      { x: 0, y: 0, z: 0 },
    );
    const average = {
      x: sum.x / readings.length,
      y: sum.y / readings.length,
      z: sum.z / readings.length,
    };
    const averageDirection = normalize(average);
    const minimumCosine = Math.cos((config.maximumDirectionSpreadDegrees * Math.PI) / 180);
    if (readings.some((reading) => dot(reading.direction, averageDirection) < minimumCosine)) {
      return Object.freeze({ ready: false, reason: "HOLD BIKE STEADY", gravity: null });
    }
    return Object.freeze({ ready: true, reason: "READY TO ZERO", gravity: Object.freeze(average) });
  }

  function reset() {
    readings = [];
  }

  return Object.freeze({ add, snapshot, reset });
}
