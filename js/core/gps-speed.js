const EARTH_RADIUS_METRES = 6_371_000;

export const METRES_PER_SECOND_TO_MPH = 2.23694;
export const GPS_SPEED_SOURCE = Object.freeze({
  PLATFORM: "platform",
  DERIVED: "derived",
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
  return Object.freeze({ latitude: sample.latitude, longitude: sample.longitude });
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
export function createGpsSpeedometer({ smoothingFactor = 0.35, integerHysteresisMph = 0.75 } = {}) {
  if (!Number.isFinite(smoothingFactor) || smoothingFactor <= 0 || smoothingFactor > 1) {
    throw new RangeError("GPS smoothing factor must be in the range (0, 1].");
  }
  if (!Number.isFinite(integerHysteresisMph) || integerHysteresisMph < 0.5) {
    throw new RangeError("GPS integer hysteresis must be at least 0.5 MPH.");
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
      (previousPosition !== null && sample.timestamp <= previousPosition.timestamp)
    ) {
      return false;
    }

    hasFix = true;
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

    const derivedHeading = previousPosition === null
      ? null
      : bearingDegrees(previousPosition, sample);
    headingDegrees = Number.isFinite(sample.heading)
      ? normalizeHeading(sample.heading)
      : derivedHeading;
    courseHeadingDegrees = derivedHeading;
    evidenceSpeedMps = metresPerSecond;
    accuracy = Number.isFinite(sample.accuracy) && sample.accuracy >= 0 ? sample.accuracy : null;
    previousPosition = {
      timestamp: sample.timestamp,
      latitude: sample.latitude,
      longitude: sample.longitude,
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
    const hasSpeed = hasFix && displayedMph !== null;
    return Object.freeze({
      hasFix,
      hasSpeed,
      mph: hasSpeed ? displayedMph : null,
      source: hasSpeed ? speedSource : null,
      warning: hasFix ? (hasSpeed ? "" : "GPS · SPEED ACQUIRING") : "GPS · NO FIX",
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
