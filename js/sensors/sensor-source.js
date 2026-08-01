export const SENSOR_STATUS = Object.freeze({
  GRANTED: "granted",
  DENIED: "denied",
  UNAVAILABLE: "unavailable",
  UNSUPPORTED: "unsupported",
});

const DEFAULT_LOCATION_TIMEOUT_MS = 10_000;

function result(status, reason = "") {
  return Object.freeze({ status, reason });
}

/**
 * The app's single sensor subscription seam. A later synthetic source only
 * needs to implement requestAccess(), subscribe(), and destroy().
 */
export function createBrowserSensorSource({
  windowRef = globalThis.window,
  navigatorRef = globalThis.navigator,
  setTimeoutRef = globalThis.setTimeout,
  clearTimeoutRef = globalThis.clearTimeout,
  locationTimeoutMs = DEFAULT_LOCATION_TIMEOUT_MS,
  permissionTimeoutMs = DEFAULT_LOCATION_TIMEOUT_MS,
} = {}) {
  const subscribers = new Set();
  let orientationListening = false;
  let locationWatchId = null;
  let accessPromise = null;
  let destroyed = false;

  function emit(sample) {
    if (destroyed) return;
    for (const subscriber of subscribers) subscriber(sample);
  }

  function onOrientation(event) {
    if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return;

    emit({
      type: "orientation",
      timestamp: Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now(),
      beta: event.beta,
      gamma: event.gamma,
      alpha: Number.isFinite(event.alpha) ? event.alpha : null,
    });
  }

  function startOrientationEvents() {
    if (destroyed || orientationListening) return;
    windowRef.addEventListener("deviceorientation", onOrientation, true);
    orientationListening = true;
  }

  function requestMotionAccess() {
    const OrientationEvent = windowRef?.DeviceOrientationEvent;
    if (!OrientationEvent || typeof windowRef?.addEventListener !== "function") {
      return Promise.resolve(result(SENSOR_STATUS.UNSUPPORTED, "Device orientation is not available."));
    }

    if (typeof OrientationEvent.requestPermission !== "function") {
      startOrientationEvents();
      return Promise.resolve(result(SENSOR_STATUS.GRANTED, "Direct event subscription is available."));
    }

    let permissionRequest;
    try {
      // This call is deliberately made before requestAccess() yields, preserving
      // iOS Safari's requirement that it occur inside the button gesture.
      permissionRequest = OrientationEvent.requestPermission();
    } catch (error) {
      return Promise.resolve(result(SENSOR_STATUS.UNSUPPORTED, error?.message ?? "Motion access failed."));
    }

    return new Promise((resolve) => {
      let settled = false;
      const fallbackTimer = setTimeoutRef(() => {
        settled = true;
        resolve(result(SENSOR_STATUS.UNSUPPORTED, "Motion permission did not respond in time."));
      }, permissionTimeoutMs);

      function finish(outcome) {
        if (settled) return;
        settled = true;
        clearTimeoutRef(fallbackTimer);
        resolve(outcome);
      }

      Promise.resolve(permissionRequest)
        .then((permission) => {
          if (settled) return;
          if (permission === "granted") {
            startOrientationEvents();
            finish(result(SENSOR_STATUS.GRANTED));
            return;
          }
          finish(result(SENSOR_STATUS.DENIED, "Motion permission was denied."));
        })
        .catch((error) =>
          finish(result(SENSOR_STATUS.UNSUPPORTED, error?.message ?? "Motion access failed.")),
        );
    });
  }

  function requestLocationAccess() {
    const geolocation = navigatorRef?.geolocation;
    if (!geolocation || typeof geolocation.watchPosition !== "function") {
      return Promise.resolve(result(SENSOR_STATUS.UNSUPPORTED, "Geolocation is not available."));
    }

    return new Promise((resolve) => {
      let settled = false;
      let watchShouldContinue = true;
      let currentStatus = null;
      let fallbackTimer = null;

      function settle(outcome) {
        if (settled) return;
        settled = true;
        currentStatus = outcome.status;
        if (fallbackTimer !== null) clearTimeoutRef(fallbackTimer);
        resolve(outcome);
      }

      function stopUnavailableWatch() {
        if (locationWatchId !== null && typeof geolocation.clearWatch === "function") {
          geolocation.clearWatch(locationWatchId);
          locationWatchId = null;
        }
      }

      function onPosition(position) {
        if (
          settled &&
          currentStatus !== SENSOR_STATUS.UNAVAILABLE &&
          currentStatus !== SENSOR_STATUS.GRANTED
        ) {
          return;
        }
        const recoveredFromUnavailable = settled && currentStatus === SENSOR_STATUS.UNAVAILABLE;
        const { coords } = position;
        emit({
          type: "location",
          timestamp: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          speed: Number.isFinite(coords.speed) ? coords.speed : null,
          heading: Number.isFinite(coords.heading) ? coords.heading : null,
        });
        settle(result(SENSOR_STATUS.GRANTED));

        if (recoveredFromUnavailable) {
          currentStatus = SENSOR_STATUS.GRANTED;
          emit({
            type: "access",
            sensor: "location",
            outcome: result(SENSOR_STATUS.GRANTED),
          });
        }
      }

      function onLocationError(error) {
        if (settled) return;
        if (error?.code === 1) {
          watchShouldContinue = false;
          stopUnavailableWatch();
          settle(result(SENSOR_STATUS.DENIED, "Location permission was denied."));
          return;
        }

        settle(
          result(
            SENSOR_STATUS.UNAVAILABLE,
            error?.message ?? "Location is temporarily unavailable.",
          ),
        );
      }

      try {
        // Starting the watch synchronously triggers the browser's location
        // prompt from the same ENABLE SENSORS gesture as motion permission.
        locationWatchId = geolocation.watchPosition(onPosition, onLocationError, {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: locationTimeoutMs,
        });
        if (settled) {
          if (!watchShouldContinue) stopUnavailableWatch();
          return;
        }
        fallbackTimer = setTimeoutRef(() => {
          settle(result(SENSOR_STATUS.UNAVAILABLE, "Location did not respond in time."));
        }, locationTimeoutMs + 250);
      } catch (error) {
        watchShouldContinue = false;
        stopUnavailableWatch();
        settle(result(SENSOR_STATUS.UNSUPPORTED, error?.message ?? "Location access failed."));
      }
    });
  }

  function requestAccess() {
    if (accessPromise) return accessPromise;

    // Invoke both request functions before awaiting either one. This is
    // important on iOS, where both browser prompts must originate in the tap.
    const motionRequest = requestMotionAccess();
    const locationRequest = requestLocationAccess();
    accessPromise = Promise.all([motionRequest, locationRequest]).then(([motion, location]) =>
      Object.freeze({ motion, location }),
    );
    return accessPromise;
  }

  function subscribe(subscriber) {
    if (typeof subscriber !== "function") {
      throw new TypeError("Sensor subscriber must be a function.");
    }
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  function destroy() {
    destroyed = true;
    subscribers.clear();
    if (orientationListening) {
      windowRef.removeEventListener("deviceorientation", onOrientation, true);
      orientationListening = false;
    }
    if (locationWatchId !== null && typeof navigatorRef?.geolocation?.clearWatch === "function") {
      navigatorRef.geolocation.clearWatch(locationWatchId);
      locationWatchId = null;
    }
  }

  return Object.freeze({ requestAccess, subscribe, destroy });
}
