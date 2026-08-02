import { cloneJsonValue } from "../core/json-value.js";
import { SENSOR_STATUS } from "./sensor-source.js";

const GRANTED_ACCESS = Object.freeze({
  motion: Object.freeze({ status: SENSOR_STATUS.GRANTED, reason: "" }),
  location: Object.freeze({ status: SENSOR_STATUS.GRANTED, reason: "" }),
});

/**
 * Creates a sensor source backed by a fixed sequence of raw samples. It uses
 * the same requestAccess/subscribe/destroy seam as the browser source.
 */
export function createTimedSensorSource(samples, {
  playbackRate = 1,
  loop = false,
  setTimeoutRef = globalThis.setTimeout,
  clearTimeoutRef = globalThis.clearTimeout,
  accessOutcomes = GRANTED_ACCESS,
  deliveryOffsetsMs,
} = {}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("A timed sensor source requires at least one sample.");
  }
  if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
    throw new RangeError("Playback rate must be a positive finite number.");
  }

  const readings = samples.map((sample, index) => {
    if (!sample || typeof sample.type !== "string" || !Number.isFinite(sample.timestamp)) {
      throw new TypeError(`Invalid sensor sample at index ${index}.`);
    }
    return cloneJsonValue(sample, `Sensor sample ${index}`);
  });
  const firstTimestamp = readings[0].timestamp;
  const timings = deliveryOffsetsMs ?? readings.map((sample) => Math.max(0, sample.timestamp - firstTimestamp));
  if (!Array.isArray(timings) || timings.length !== readings.length) {
    throw new TypeError("Delivery offsets must match the sensor sample count.");
  }
  timings.forEach((offset, index) => {
    if (!Number.isFinite(offset) || offset < 0 || (index > 0 && offset < timings[index - 1])) {
      throw new RangeError("Delivery offsets must be finite, non-negative, and ordered.");
    }
  });

  const subscribers = new Set();
  let timerId = null;
  let nextIndex = 0;
  let started = false;
  let destroyed = false;
  let accessPromise = null;

  function emitNext() {
    if (destroyed || !started) return;

    const reading = readings[nextIndex];
    for (const subscriber of subscribers) subscriber(cloneJsonValue(reading, "Sensor reading"));
    nextIndex += 1;

    if (nextIndex >= readings.length) {
      if (!loop) {
        started = false;
        timerId = null;
        return;
      }
      nextIndex = 0;
    }

    const previousOffset = timings[nextIndex === 0 ? timings.length - 1 : nextIndex - 1];
    const nextOffset = timings[nextIndex];
    const loopOffset = nextIndex === 0 ? timings.at(-1) : 0;
    const delay = Math.max(0, (nextOffset + loopOffset - previousOffset) / playbackRate);
    timerId = setTimeoutRef(emitNext, delay);
  }

  function requestAccess() {
    if (!accessPromise) {
      accessPromise = Promise.resolve(accessOutcomes);
      started = true;
      timerId = setTimeoutRef(emitNext, 0);
    }
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
    started = false;
    subscribers.clear();
    if (timerId !== null) clearTimeoutRef(timerId);
    timerId = null;
  }

  return Object.freeze({ requestAccess, subscribe, destroy });
}
