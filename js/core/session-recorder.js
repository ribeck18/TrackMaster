const DEFAULT_SAMPLE_INTERVAL_MS = 50;
const DEFAULT_FORCED_SAMPLE_INTERVAL_MS = 10;

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function createSample(reading, timestamp, startedAt) {
  const position = reading.position;
  return {
    t: timestamp - startedAt,
    timestamp,
    latitude: finiteOrNull(position?.latitude),
    longitude: finiteOrNull(position?.longitude),
    locationTimestamp: finiteOrNull(position?.timestamp),
    speedMph: finiteOrNull(reading.speedMph),
    speedValid: reading.speedValid === true,
    leanDegrees: finiteOrNull(reading.leanDegrees),
  };
}

/**
 * Records report-ready derived readings independently from the dev raw recorder.
 * Instrument samples are capped at 20 Hz. Native GPS fixes may be added between
 * them, with duplicate/pathological bursts coalesced to at most 100 Hz.
 */
export function createSessionRecorder({
  nowRef = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now,
  minimumIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  minimumForcedIntervalMs = DEFAULT_FORCED_SAMPLE_INTERVAL_MS,
} = {}) {
  if (typeof nowRef !== "function") throw new TypeError("Session recorder requires a clock.");
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) {
    throw new RangeError("Sample interval must be a non-negative finite number.");
  }
  if (!Number.isFinite(minimumForcedIntervalMs) || minimumForcedIntervalMs < 0) {
    throw new RangeError("Forced sample interval must be a non-negative finite number.");
  }

  let startedAt = null;
  let stoppedAt = null;
  let lastSeenAt = null;
  let lastInstrumentAt = null;
  let lastForcedAt = null;
  let samples = [];

  function start(timestamp = nowRef()) {
    if (!Number.isFinite(timestamp)) throw new TypeError("Session start must be finite.");
    startedAt = timestamp;
    stoppedAt = null;
    lastSeenAt = null;
    lastInstrumentAt = null;
    lastForcedAt = null;
    samples = [];
  }

  function record(reading = {}, timestamp = nowRef(), { force = false } = {}) {
    if (startedAt === null || stoppedAt !== null) return false;
    if (!Number.isFinite(timestamp) || timestamp < startedAt) {
      throw new RangeError("Sample timestamps must be finite and not precede the session.");
    }
    if (lastSeenAt !== null && timestamp < lastSeenAt) {
      throw new RangeError("Sample timestamps must be monotonic.");
    }
    lastSeenAt = timestamp;

    const nextSample = createSample(reading, timestamp, startedAt);
    const latestSample = samples.at(-1);
    if (latestSample?.timestamp === timestamp) {
      // One monotonic instant represents one coherent reading. A forced GPS
      // update at the same instant replaces, rather than duplicates, it.
      samples[samples.length - 1] = nextSample;
      if (force) lastForcedAt = timestamp;
      else lastInstrumentAt = timestamp;
      return false;
    }

    if (force) {
      const forcedAnchor = lastForcedAt ?? latestSample?.timestamp;
      if (Number.isFinite(forcedAnchor) && timestamp - forcedAnchor < minimumForcedIntervalMs) {
        // Preserve the newest native GPS state without allowing a malformed
        // high-rate source to grow the buffer without bound.
        samples[samples.length - 1] = nextSample;
        return false;
      }
      samples.push(nextSample);
      lastForcedAt = timestamp;
      return true;
    }

    if (lastInstrumentAt !== null && timestamp - lastInstrumentAt < minimumIntervalMs) {
      return false;
    }
    samples.push(nextSample);
    lastInstrumentAt = timestamp;
    return true;
  }

  function stop(timestamp = nowRef()) {
    if (startedAt === null) throw new Error("No session is recording.");
    if (!Number.isFinite(timestamp) || timestamp < startedAt) {
      throw new RangeError("Session end must be finite and not precede the session.");
    }
    if (Number.isFinite(lastSeenAt) && timestamp < lastSeenAt) {
      throw new RangeError("Session end cannot precede the last seen reading.");
    }
    stoppedAt = timestamp;
    return Object.freeze({
      startedAt,
      endedAt: stoppedAt,
      samples: Object.freeze(samples.map((sample) => Object.freeze(sample))),
    });
  }

  return Object.freeze({
    start,
    record,
    stop,
    isRecording: () => startedAt !== null && stoppedAt === null,
    sampleCount: () => samples.length,
  });
}
