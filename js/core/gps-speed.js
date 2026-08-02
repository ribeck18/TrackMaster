const EARTH_RADIUS_METRES = 6_371_000;

export const METRES_PER_SECOND_TO_MPH = 2.23694;
export const MAXIMUM_GPS_FIX_AGE_MS = 2_000;
export const GPS_SPEED_SOURCE = Object.freeze({
  PLATFORM: "platform",
  DERIVED: "derived",
});
/**
 * Shared live/report/lean location policy. The 100 m/s ceiling is about 224
 * MPH, above the tested 179 MPH track case; the remaining limits reject poor
 * fixes and platform-speed/coordinate disagreement without an acceleration
 * gate that would delay recovery after an outlier.
 */
export const DEFAULT_GPS_VALIDATION_OPTIONS = Object.freeze({
  maximumSpeedMps: 100,
  maximumHorizontalAccuracyMetres: 25,
  maximumSpeedDisagreementMps: 30,
});

function isValidCoordinate(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function radians(degrees) {
  return (degrees * Math.PI) / 180;
}

export function isAcceptedLocationSample(sample, acceptedTimestamp) {
  return Number.isFinite(acceptedTimestamp) && sample?.timestamp === acceptedTimestamp;
}

/** Keeps report coordinates aligned with the exact fix accepted by the speedometer. */
export function positionForAcceptedLocation(sample, acceptedTimestamp, currentPosition = null) {
  if (
    !isAcceptedLocationSample(sample, acceptedTimestamp) ||
    !isValidCoordinate(sample.latitude, sample.longitude)
  ) {
    return currentPosition;
  }
  return Object.freeze({
    latitude: sample.latitude,
    longitude: sample.longitude,
    timestamp: sample.timestamp,
  });
}

function normalizeHeading(degrees) {
  return ((degrees % 360) + 360) % 360;
}

export function bearingDegrees(first, second) {
  if (
    !isValidCoordinate(first?.latitude, first?.longitude) ||
    !isValidCoordinate(second?.latitude, second?.longitude) ||
    distanceMetres(first, second) < 1
  ) {
    return null;
  }
  const firstLatitude = radians(first.latitude);
  const secondLatitude = radians(second.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const y = Math.sin(longitudeDelta) * Math.cos(secondLatitude);
  const x =
    Math.cos(firstLatitude) * Math.sin(secondLatitude) -
    Math.sin(firstLatitude) * Math.cos(secondLatitude) * Math.cos(longitudeDelta);
  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
}

export function distanceMetres(first, second) {
  if (
    !isValidCoordinate(first?.latitude, first?.longitude) ||
    !isValidCoordinate(second?.latitude, second?.longitude)
  ) {
    return null;
  }

  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const firstLatitude = radians(first.latitude);
  const secondLatitude = radians(second.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function deriveSpeedMetresPerSecond(previous, current) {
  if (!Number.isFinite(previous?.timestamp) || !Number.isFinite(current?.timestamp)) return null;
  const elapsedSeconds = (current.timestamp - previous.timestamp) / 1_000;
  if (elapsedSeconds <= 0) return null;

  const distance = distanceMetres(previous, current);
  return distance === null ? null : distance / elapsedSeconds;
}

/**
 * Turns raw location samples from any SensorSource into one stable instrument
 * value. Location fixes are processed at their native cadence; consumers can
 * render snapshot() on a ~5 Hz timer without exposing raw GPS jitter.
 */
export function createGpsSpeedometer({
  smoothingFactor = 0.35,
  integerHysteresisMph = 0.75,
  maximumSpeedMps = DEFAULT_GPS_VALIDATION_OPTIONS.maximumSpeedMps,
  maximumHorizontalAccuracyMetres =
    DEFAULT_GPS_VALIDATION_OPTIONS.maximumHorizontalAccuracyMetres,
  maximumSpeedDisagreementMps = DEFAULT_GPS_VALIDATION_OPTIONS.maximumSpeedDisagreementMps,
  maximumAgeMs = MAXIMUM_GPS_FIX_AGE_MS,
  nowRef = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now,
} = {}) {
  if (!Number.isFinite(smoothingFactor) || smoothingFactor <= 0 || smoothingFactor > 1) {
    throw new RangeError("GPS smoothing factor must be in the range (0, 1].");
  }
  if (!Number.isFinite(integerHysteresisMph) || integerHysteresisMph < 0.5) {
    throw new RangeError("GPS integer hysteresis must be at least 0.5 MPH.");
  }
  if (typeof nowRef !== "function") {
    throw new TypeError("GPS monotonic clock must be a function.");
  }
  for (const [name, value] of Object.entries({
    maximumSpeedMps,
    maximumHorizontalAccuracyMetres,
    maximumSpeedDisagreementMps,
    maximumAgeMs,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive finite number.`);
    }
  }

  let previousPosition = null;
  let hasFix = false;
  let smoothedMph = null;
  let displayedMph = null;
  let speedSource = null;
  let headingDegrees = null;
  let courseHeadingDegrees = null;
  let evidenceSpeedMps = null;
  let accuracy = null;
  let acceptedLocationTimestamp = null;
  let lastAcceptedAt = null;

  function clearFix() {
    previousPosition = null;
    hasFix = false;
    smoothedMph = null;
    displayedMph = null;
    speedSource = null;
    headingDegrees = null;
    courseHeadingDegrees = null;
    evidenceSpeedMps = null;
    accuracy = null;
    acceptedLocationTimestamp = null;
    lastAcceptedAt = null;
  }

  function updateDisplayedValue() {
    if (displayedMph === null) {
      displayedMph = Math.max(0, Math.round(smoothedMph));
      return;
    }

    if (Math.abs(smoothedMph - displayedMph) >= integerHysteresisMph) {
      displayedMph = Math.max(0, Math.round(smoothedMph));
    }
  }

  function handleLocation(sample) {
    if (
      !isValidCoordinate(sample.latitude, sample.longitude) ||
      !Number.isFinite(sample.timestamp) ||
      !Number.isFinite(sample.accuracy) ||
      sample.accuracy < 0 ||
      sample.accuracy > maximumHorizontalAccuracyMetres ||
      (previousPosition !== null && sample.timestamp <= previousPosition.timestamp)
    ) {
      return false;
    }

    let metresPerSecond = null;
    let source = null;

    // WebKit uses null when its native speed estimate is unavailable. Negative
    // values are also unusable and intentionally fall through to derivation.
    if (Number.isFinite(sample.speed) && sample.speed >= 0) {
      metresPerSecond = sample.speed;
      source = GPS_SPEED_SOURCE.PLATFORM;
    } else {
      metresPerSecond = deriveSpeedMetresPerSecond(previousPosition, sample);
      if (metresPerSecond !== null) source = GPS_SPEED_SOURCE.DERIVED;
    }

    if (metresPerSecond !== null && metresPerSecond > maximumSpeedMps) return false;

    if (previousPosition !== null) {
      const elapsedSeconds = (sample.timestamp - previousPosition.timestamp) / 1_000;
      const displacement = distanceMetres(previousPosition, sample);
      const displacementSpeed = displacement / elapsedSeconds;
      if (displacementSpeed > maximumSpeedMps) return false;

      const uncertaintyMetres = previousPosition.accuracy + sample.accuracy;
      if (
        source === GPS_SPEED_SOURCE.PLATFORM &&
        Math.abs(displacement - metresPerSecond * elapsedSeconds) >
          uncertaintyMetres + maximumSpeedDisagreementMps * elapsedSeconds
      ) {
        return false;
      }

      // With no native speed, displacement contained entirely inside the two
      // horizontal-accuracy radii is stationary rather than invented motion.
      if (source === GPS_SPEED_SOURCE.DERIVED && displacement <= uncertaintyMetres) {
        metresPerSecond = 0;
      }
    }

    // This is the sole acceptance point. All live/report/lean state changes
    // happen below it, so rejected fixes leave the last credible baseline
    // intact and the next credible fix can recover without an acceleration gate.
    hasFix = true;
    lastAcceptedAt = nowRef();
    const derivedHeading = previousPosition === null
      ? null
      : bearingDegrees(previousPosition, sample);
    headingDegrees = Number.isFinite(sample.heading)
      ? normalizeHeading(sample.heading)
      : derivedHeading;
    courseHeadingDegrees = derivedHeading;
    evidenceSpeedMps = metresPerSecond;
    accuracy = sample.accuracy;
    previousPosition = {
      timestamp: sample.timestamp,
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracy: sample.accuracy,
    };

    if (metresPerSecond === null) return true;
    const mph = metresPerSecond * METRES_PER_SECOND_TO_MPH;
    smoothedMph =
      smoothedMph === null ? mph : smoothedMph + smoothingFactor * (mph - smoothedMph);
    speedSource = source;
    updateDisplayedValue();
    return true;
  }

  function handle(sample) {
    acceptedLocationTimestamp = null;
    if (sample?.type === "location") {
      if (handleLocation(sample)) acceptedLocationTimestamp = sample.timestamp;
    } else if (
      sample?.type === "access" &&
      sample.sensor === "location" &&
      sample.outcome?.status !== "granted"
    ) {
      clearFix();
    }
    return snapshot();
  }

  function kinematicSample() {
    if (!previousPosition) return null;
    return Object.freeze({
      type: "location",
      timestamp: previousPosition.timestamp,
      speedMps: smoothedMph === null ? null : smoothedMph / METRES_PER_SECOND_TO_MPH,
      evidenceSpeedMps,
      headingDegrees,
      courseHeadingDegrees,
      accuracy,
    });
  }

  function snapshot() {
    const ageMs = nowRef() - lastAcceptedAt;
    const isFresh =
      hasFix &&
      Number.isFinite(lastAcceptedAt) &&
      Number.isFinite(ageMs) &&
      ageMs >= 0 &&
      ageMs <= maximumAgeMs;
    const hasSpeed = isFresh && displayedMph !== null;
    return Object.freeze({
      hasFix,
      hasSpeed,
      mph: hasSpeed ? displayedMph : null,
      source: hasSpeed ? speedSource : null,
      warning: !hasFix
        ? "GPS · NO FIX"
        : !isFresh
          ? "GPS · STALE"
          : hasSpeed
            ? ""
            : "GPS · SPEED ACQUIRING",
    });
  }

  return Object.freeze({
    handle,
    clearFix,
    kinematicSample,
    snapshot,
    acceptedLocationTimestamp: () => acceptedLocationTimestamp,
  });
}
