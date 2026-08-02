function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function speedOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function validPosition(latitude, longitude) {
  return (
    Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
  );
}

export const MAX_VALID_SPEED_INTERVAL_MS = 2_000;

function freezeSample(sample, startedAt) {
  const timestamp = sample.timestamp;
  const hasPosition = validPosition(sample.latitude, sample.longitude);
  return Object.freeze({
    // Never trust an externally supplied relative time for map/export context.
    // Normalize it from the validated monotonic timestamp and session origin.
    t: timestamp - startedAt,
    timestamp,
    latitude: hasPosition ? sample.latitude : null,
    longitude: hasPosition ? sample.longitude : null,
    speedMph: speedOrNull(sample.speedMph),
    speedValid: sample.speedValid === true,
    leanDegrees: finiteOrNull(sample.leanDegrees),
  });
}

function validateTiming(timing) {
  if (
    !timing ||
    !Number.isFinite(timing.sessionStartTime) ||
    !Number.isFinite(timing.endedAt) ||
    timing.endedAt < timing.sessionStartTime ||
    !Array.isArray(timing.laps)
  ) {
    throw new TypeError("An ended lap-timing session is required.");
  }

  let boundary = timing.sessionStartTime;
  let expectedIndex = 1;
  for (const lap of timing.laps) {
    if (
      lap.index !== expectedIndex ||
      !Number.isFinite(lap.startTime) ||
      !Number.isFinite(lap.endTime) ||
      !Number.isFinite(lap.duration) ||
      lap.startTime !== boundary ||
      lap.endTime <= lap.startTime ||
      lap.duration !== lap.endTime - lap.startTime ||
      lap.endTime > timing.endedAt
    ) {
      throw new RangeError("Completed lap boundaries must be monotonic and internally consistent.");
    }
    boundary = lap.endTime;
    expectedIndex += 1;
  }
}

function copySessionSamples(samples, startedAt, endedAt) {
  if (!Array.isArray(samples)) throw new TypeError("Session samples must be an array.");

  let previousTimestamp = Number.NEGATIVE_INFINITY;
  const copies = [];
  for (const sample of samples) {
    if (!sample || !Number.isFinite(sample.timestamp)) {
      throw new TypeError("Every session sample requires a finite monotonic timestamp.");
    }
    if (sample.timestamp < previousTimestamp) {
      throw new RangeError("Session sample timestamps must be monotonic.");
    }
    previousTimestamp = sample.timestamp;
    if (sample.timestamp < startedAt || sample.timestamp > endedAt) continue;
    copies.push(freezeSample(sample, startedAt));
  }
  return Object.freeze(copies);
}

function timeWeightedAverageSpeed(samples) {
  let weightedSpeed = 0;
  let coveredDuration = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (
      !previous.speedValid ||
      !current.speedValid ||
      previous.speedMph === null ||
      current.speedMph === null
    ) {
      continue;
    }
    const duration = current.timestamp - previous.timestamp;
    // Even two endpoints marked valid cannot prove coverage through a long
    // silent GPS gap. Recovery starts a new measurable interval.
    if (duration <= 0 || duration > MAX_VALID_SPEED_INTERVAL_MS) continue;
    weightedSpeed += ((previous.speedMph + current.speedMph) / 2) * duration;
    coveredDuration += duration;
  }

  return coveredDuration === 0 ? null : weightedSpeed / coveredDuration;
}

function lapContextFor(timestamp, timing) {
  let startTime = timing.sessionStartTime;
  let index = 1;
  for (const lap of timing.laps) {
    // A tap instant is the first instant of the next lap.
    if (timestamp < lap.endTime) {
      return Object.freeze({
        index: lap.index,
        elapsedMs: timestamp - lap.startTime,
        completed: true,
      });
    }
    startTime = lap.endTime;
    index = lap.index + 1;
  }
  return Object.freeze({
    index,
    elapsedMs: timestamp - startTime,
    completed: false,
  });
}

function aggregateSamples(samples, timing) {
  let maxSpeedMph = null;
  let maxLeanLeftDegrees = null;
  let maxLeanRightDegrees = null;
  let topSample = null;
  let locationSampleCount = 0;
  let hasLeanData = false;

  for (const sample of samples) {
    const positioned = sample.latitude !== null && sample.longitude !== null;
    if (positioned) locationSampleCount += 1;

    if (sample.speedValid && sample.speedMph !== null) {
      const isHigher = maxSpeedMph === null || sample.speedMph > maxSpeedMph;
      const replacesUnpositionedTie =
        sample.speedMph === maxSpeedMph &&
        topSample !== null &&
        topSample.latitude === null &&
        positioned;
      if (isHigher || replacesUnpositionedTie) {
        maxSpeedMph = sample.speedMph;
        topSample = sample;
      }
    }
    if (sample.leanDegrees !== null) {
      hasLeanData = true;
      if (sample.leanDegrees < 0) {
        maxLeanLeftDegrees = Math.max(maxLeanLeftDegrees ?? 0, -sample.leanDegrees);
      }
      if (sample.leanDegrees > 0) {
        maxLeanRightDegrees = Math.max(maxLeanRightDegrees ?? 0, sample.leanDegrees);
      }
    }
  }
  if (hasLeanData) {
    maxLeanLeftDegrees ??= 0;
    maxLeanRightDegrees ??= 0;
  }

  // Speed is GPS-derived in this app. Without any valid coordinate fix the
  // session has no defensible speed statistics, even if malformed input carries
  // numeric speed fields.
  if (locationSampleCount === 0) {
    maxSpeedMph = null;
    topSample = null;
  }

  const topSpeedPoint = topSample === null
    ? null
    : Object.freeze({
        speedMph: topSample.speedMph,
        timestamp: topSample.timestamp,
        t: topSample.t,
        position:
          topSample.latitude === null || topSample.longitude === null
            ? null
            : Object.freeze({ latitude: topSample.latitude, longitude: topSample.longitude }),
        lap: lapContextFor(topSample.timestamp, timing),
      });

  return Object.freeze({
    maxSpeedMph,
    averageSpeedMph: locationSampleCount === 0 ? null : timeWeightedAverageSpeed(samples),
    maxLeanLeftDegrees,
    maxLeanRightDegrees,
    locationSampleCount,
    topSpeedPoint,
  });
}

/**
 * Builds a detached, deeply immutable report from one ended monotonic session.
 * Samples outside that session's [start, end] interval cannot affect results.
 */
export function aggregateRunReport(
  { timing, samples },
  { runNumber = 1, runId = null, riderId = null } = {},
) {
  validateTiming(timing);
  if (!Number.isInteger(runNumber) || runNumber < 1) {
    throw new RangeError("Run number must be a positive integer.");
  }
  if ((runId !== null && typeof runId !== "string") || (riderId !== null && typeof riderId !== "string")) {
    throw new TypeError("Reserved run and rider identifiers must be strings or null.");
  }

  const copiedSamples = copySessionSamples(samples, timing.sessionStartTime, timing.endedAt);
  const bestDuration = timing.laps.length === 0
    ? null
    : Math.min(...timing.laps.map((lap) => lap.duration));
  const laps = Object.freeze(
    timing.laps.map((lap) => Object.freeze({
      index: lap.index,
      startTime: lap.startTime,
      endTime: lap.endTime,
      duration: lap.duration,
      isBest: lap.duration === bestDuration,
    })),
  );
  const bestLap = bestDuration === null
    ? null
    : Object.freeze({
        index: laps.find((lap) => lap.isBest).index,
        duration: bestDuration,
      });
  const stats = aggregateSamples(copiedSamples, timing);

  return Object.freeze({
    runId,
    riderId,
    runNumber,
    startedAt: timing.sessionStartTime,
    endedAt: timing.endedAt,
    totalDurationMs: timing.endedAt - timing.sessionStartTime,
    lapCount: laps.length,
    laps,
    bestLap,
    stats: Object.freeze({
      maxSpeedMph: stats.maxSpeedMph,
      averageSpeedMph: stats.averageSpeedMph,
      maxLeanLeftDegrees: stats.maxLeanLeftDegrees,
      maxLeanRightDegrees: stats.maxLeanRightDegrees,
    }),
    topSpeedPoint: stats.topSpeedPoint,
    location: Object.freeze({
      available: stats.locationSampleCount > 0,
      sampleCount: stats.locationSampleCount,
    }),
    samples: copiedSamples,
  });
}
