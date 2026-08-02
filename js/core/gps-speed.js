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

  function clearFix() {
    previousPosition = null;
    hasFix = false;
    smoothedMph = null;
    displayedMph = null;
    speedSource = null;
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
      return;
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

    previousPosition = {
      timestamp: sample.timestamp,
      latitude: sample.latitude,
      longitude: sample.longitude,
    };

    if (metresPerSecond === null) return;
    const mph = metresPerSecond * METRES_PER_SECOND_TO_MPH;
    smoothedMph =
      smoothedMph === null ? mph : smoothedMph + smoothingFactor * (mph - smoothedMph);
    speedSource = source;
    updateDisplayedValue();
  }

  function handle(sample) {
    if (sample?.type === "location") {
      handleLocation(sample);
    } else if (
      sample?.type === "access" &&
      sample.sensor === "location" &&
      sample.outcome?.status !== "granted"
    ) {
      clearFix();
    }
    return snapshot();
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

  return Object.freeze({ handle, clearFix, snapshot });
}
