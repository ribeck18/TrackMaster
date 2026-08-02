import {
  loadRawSensorLog,
  RAW_SENSOR_LOG_LEGACY_VERSION,
  validateRawSensorLog,
} from "../core/raw-sensor-log.js";
import { SENSOR_STATUS } from "../sensors/sensor-source.js";
import { createTimedSensorSource } from "../sensors/timed-sensor-source.js";

const GRANTED_ACCESS = Object.freeze({
  motion: Object.freeze({ status: SENSOR_STATUS.GRANTED, reason: "" }),
  location: Object.freeze({ status: SENSOR_STATUS.GRANTED, reason: "" }),
});

/** Replay a validated log without changing timestamps or reading values. */
export function createReplaySensorSource(log, options = {}) {
  const validated = validateRawSensorLog(log);

  // Version 1 predates initialization actions and intentionally retains its
  // historical play-on-access behavior.
  if (validated.version === RAW_SENSOR_LOG_LEGACY_VERSION) {
    return createTimedSensorSource(validated.samples, {
      loop: false,
      deliveryOffsetsMs: validated.deliveryOffsetsMs,
      ...options,
    });
  }

  const initialization = validated.replayInitialization;
  const subscribers = new Set();
  const accessOutcomes = options.accessOutcomes ?? GRANTED_ACCESS;
  const actionSamples = initialization.samples.slice(0, initialization.actionSampleCount);
  const actionOffsets = initialization.deliveryOffsetsMs.slice(0, initialization.actionSampleCount);
  const postActionSamples = initialization.samples.slice(initialization.actionSampleCount);
  const postActionOffsets = initialization.deliveryOffsetsMs.slice(initialization.actionSampleCount);
  let destroyed = false;
  let actionInitialized = false;
  let initialized = false;
  let actionPromise = null;
  let initializationPromise = null;
  let initializationSource = null;
  let pendingPhaseReject = null;
  let replayStarted = false;

  function forward(sample) {
    if (destroyed) return;
    for (const subscriber of subscribers) subscriber(sample);
  }

  const raceSource = validated.samples.length > 0
    ? createTimedSensorSource(validated.samples, {
        loop: false,
        deliveryOffsetsMs: validated.deliveryOffsetsMs,
        ...options,
      })
    : null;
  const unsubscribeRace = raceSource?.subscribe(forward) ?? (() => {});

  function requestAccess() {
    return Promise.resolve(accessOutcomes);
  }

  function subscribe(subscriber) {
    if (typeof subscriber !== "function") {
      throw new TypeError("Sensor subscriber must be a function.");
    }
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  function getReplayInitialization() {
    return initialization;
  }

  function playPhase(samples, deliveryOffsetsMs, onComplete) {
    if (samples.length === 0) {
      onComplete();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let delivered = 0;
      let settled = false;

      function rejectPhase(error) {
        if (settled) return;
        settled = true;
        pendingPhaseReject = null;
        initializationSource?.destroy();
        initializationSource = null;
        reject(error);
      }

      pendingPhaseReject = rejectPhase;
      try {
        initializationSource = createTimedSensorSource(samples, {
          loop: false,
          deliveryOffsetsMs,
          ...options,
        });
        initializationSource.subscribe((sample) => {
          if (settled) return;
          forward(sample);
          delivered += 1;
          if (delivered === samples.length) {
            settled = true;
            pendingPhaseReject = null;
            onComplete();
            initializationSource.destroy();
            initializationSource = null;
            resolve();
          }
        });
        void initializationSource.requestAccess().catch(rejectPhase);
      } catch (error) {
        rejectPhase(error);
      }
    });
  }

  function initializeAction() {
    if (destroyed) return Promise.reject(new Error("Cannot initialize a destroyed replay source."));
    if (!actionPromise) {
      actionPromise = playPhase(
        actionSamples,
        actionOffsets,
        () => { actionInitialized = true; },
      );
    }
    return actionPromise;
  }

  function initializeReplay() {
    if (destroyed) return Promise.reject(new Error("Cannot initialize a destroyed replay source."));
    if (!actionInitialized) {
      return Promise.reject(new Error("Recorded pre-action samples must replay before initialization."));
    }
    if (!initializationPromise) {
      initializationPromise = playPhase(
        postActionSamples,
        postActionOffsets,
        () => { initialized = true; },
      );
    }
    return initializationPromise;
  }

  function startReplay() {
    if (destroyed) throw new Error("Cannot start a destroyed replay source.");
    if (!initialized) throw new Error("Replay initialization must complete before race playback starts.");
    if (replayStarted) return;
    replayStarted = true;
    void raceSource?.requestAccess();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    pendingPhaseReject?.(new Error("Replay source was destroyed during initialization."));
    pendingPhaseReject = null;
    subscribers.clear();
    initializationSource?.destroy();
    initializationSource = null;
    unsubscribeRace();
    raceSource?.destroy();
  }

  return Object.freeze({
    requestAccess,
    subscribe,
    destroy,
    getReplayInitialization,
    initializeAction,
    initializeReplay,
    startReplay,
  });
}

/** Load JSON text/File/Blob and return a source on the unified sensor seam. */
export async function loadReplaySensorSource(input, options = {}) {
  const log = await loadRawSensorLog(input);
  return createReplaySensorSource(log, options);
}
