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
 * retained as bike vertical. The configured mount axis (the phone's long +Y
 * axis) is projected onto the plane normal to vertical, producing the
 * immediately usable assumed frame that background refinement can later rotate.
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
  captureMs: 1_000,
  minimumSpanMs: 400,
  minimumSamples: 5,
  minimumGravity: 8.5,
  maximumGravity: 11,
  maximumRateDps: 10,
  maximumDirectionSpreadDegrees: 5,
  maximumConsecutiveDisturbances: 2,
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

/** Captures one short, tap-initiated gravity+gyro sample set for ZERO. */
export function createBikeFrameCalibrationCapture({
  nowRef = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now,
  ...overrides
} = {}) {
  const config = Object.freeze({ ...DEFAULT_CALIBRATION_OPTIONS, ...overrides });
  const positiveKeys = [
    "captureMs",
    "minimumSpanMs",
    "minimumSamples",
    "minimumGravity",
    "maximumGravity",
    "maximumRateDps",
    "maximumDirectionSpreadDegrees",
    "maximumConsecutiveDisturbances",
  ];
  if (positiveKeys.some((key) => !Number.isFinite(config[key]) || config[key] <= 0)) {
    throw new RangeError("Calibration capture limits must be positive finite numbers.");
  }
  if (config.maximumGravity <= config.minimumGravity || config.minimumSpanMs > config.captureMs) {
    throw new RangeError("Calibration capture ranges are invalid.");
  }

  let startedAt = null;
  let readings = [];
  let consecutiveDisturbances = 0;
  let terminal = null;

  function result(status, reason, gravity = null) {
    return Object.freeze({ status, reason, gravity: gravity && Object.freeze(gravity) });
  }

  function cancel(reason) {
    terminal = result("cancelled", reason);
    return terminal;
  }

  function complete() {
    if (readings.length < config.minimumSamples) return cancel("INSUFFICIENT USABLE MOTION");
    const span = readings.at(-1).receivedAt - readings[0].receivedAt;
    if (span < config.minimumSpanMs) return cancel("INSUFFICIENT USABLE MOTION");

    const sum = readings.reduce(
      (total, reading) => ({
        x: total.x + reading.gravity.x,
        y: total.y + reading.gravity.y,
        z: total.z + reading.gravity.z,
      }),
      { x: 0, y: 0, z: 0 },
    );
    const gravity = {
      x: sum.x / readings.length,
      y: sum.y / readings.length,
      z: sum.z / readings.length,
    };
    const averageDirection = normalize(gravity);
    const minimumCosine = Math.cos((config.maximumDirectionSpreadDegrees * Math.PI) / 180);
    if (readings.some((reading) => dot(reading.direction, averageDirection) < minimumCosine)) {
      return cancel("REPOSITION BIKE");
    }
    terminal = result("captured", "ZERO CAPTURED", gravity);
    return terminal;
  }

  function start(receivedAt = nowRef()) {
    if (!Number.isFinite(receivedAt)) throw new RangeError("Calibration capture start time must be finite.");
    startedAt = receivedAt;
    readings = [];
    consecutiveDisturbances = 0;
    terminal = null;
    return snapshot(receivedAt);
  }

  function add(sample, receivedAt = nowRef()) {
    if (terminal || startedAt === null || !Number.isFinite(receivedAt) || receivedAt < startedAt) {
      return snapshot(receivedAt);
    }
    if (receivedAt > startedAt + config.captureMs) return complete();

    const gravity = motionGravity(sample);
    const rate = motionRate(sample);
    const gravityMagnitude = gravity ? magnitude(gravity) : 0;
    const direction = gravity && gravityMagnitude >= config.minimumGravity
      ? normalize(gravity)
      : null;
    const baseline = readings[0]?.direction;
    const minimumCosine = Math.cos((config.maximumDirectionSpreadDegrees * Math.PI) / 180);
    const repositioning = baseline && direction && dot(direction, baseline) < minimumCosine;
    const valid =
      gravity &&
      rate &&
      gravityMagnitude >= config.minimumGravity &&
      gravityMagnitude <= config.maximumGravity &&
      magnitude(rate) <= config.maximumRateDps &&
      !repositioning;

    if (!valid) {
      consecutiveDisturbances += 1;
      if (consecutiveDisturbances > config.maximumConsecutiveDisturbances) {
        return cancel(repositioning ? "REPOSITION BIKE" : "SUSTAINED MOTION");
      }
    } else {
      consecutiveDisturbances = 0;
      readings.push({ receivedAt, gravity, direction });
    }
    return receivedAt >= startedAt + config.captureMs ? complete() : snapshot(receivedAt);
  }

  function snapshot(now = nowRef()) {
    if (terminal) return terminal;
    if (startedAt === null) return result("idle", "TAP ZERO TO START");
    if (Number.isFinite(now) && now >= startedAt + config.captureMs) return complete();
    return result("capturing", "CAPTURING ZERO");
  }

  return Object.freeze({ start, add, snapshot });
}

// Retained until the UI switches from pre-tap readiness to capture.start().
export const createBikeFrameCalibrationWindow = createBikeFrameCalibrationCapture;
