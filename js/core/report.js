import { MAXIMUM_GPS_FIX_AGE_MS } from "./gps-speed.js";

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

function hasEveryArrayEntry(values) {
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index)) return false;
  }
  return true;
}

export const MAX_VALID_SPEED_INTERVAL_MS = MAXIMUM_GPS_FIX_AGE_MS;
export const LAP_TRIM_STEP_MS = 100;
export const MAX_LAP_TRIM_MS = 500;

function freezeSample(sample, startedAt, timing) {
  const timestamp = sample.timestamp;
  const hasPosition = validPosition(sample.latitude, sample.longitude);
  return Object.freeze({
    // Never trust an externally supplied relative time for map/export context.
    // Normalize it from the validated monotonic timestamp and session origin.
    t: timestamp - startedAt,
    timestamp,
    latitude: hasPosition ? sample.latitude : null,
    longitude: hasPosition ? sample.longitude : null,
    locationTimestamp:
      hasPosition && Number.isFinite(sample.locationTimestamp) ? sample.locationTimestamp : null,
    speedMph: speedOrNull(sample.speedMph),
    speedValid: sample.speedValid === true,
    leanDegrees: finiteOrNull(sample.leanDegrees),
    lap: lapContextFor(timestamp, timing),
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

function copySessionSamples(samples, timing) {
  const startedAt = timing.sessionStartTime;
  const endedAt = timing.endedAt;
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
    copies.push(freezeSample(sample, startedAt, timing));
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
        lap: topSample.lap,
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
  {
    runNumber = 1,
    runId = null,
    riderId = null,
    originalLapBoundaries = null,
    lapTrimOffsets = null,
    startedAtUnixMs = null,
    endedAtUnixMs = null,
  } = {},
) {
  validateTiming(timing);
  if (!Number.isInteger(runNumber) || runNumber < 1) {
    throw new RangeError("Run number must be a positive integer.");
  }
  if ((runId !== null && typeof runId !== "string") || (riderId !== null && typeof riderId !== "string")) {
    throw new TypeError("Reserved run and rider identifiers must be strings or null.");
  }
  if (
    (startedAtUnixMs !== null && !Number.isFinite(startedAtUnixMs)) ||
    (endedAtUnixMs !== null && !Number.isFinite(endedAtUnixMs)) ||
    ((startedAtUnixMs === null) !== (endedAtUnixMs === null)) ||
    (startedAtUnixMs !== null && Math.abs(
      (endedAtUnixMs - startedAtUnixMs) - (timing.endedAt - timing.sessionStartTime)
    ) > 1)
  ) {
    throw new RangeError("Wall-clock run boundaries must be a matching finite pair with the session duration.");
  }

  const currentBoundaries = timing.laps.map((lap) => lap.endTime);
  const originals = originalLapBoundaries ?? currentBoundaries;
  const offsets = lapTrimOffsets ?? currentBoundaries.map(() => 0);
  const originalsAreMonotonicAndInSession =
    Array.isArray(originals) &&
    hasEveryArrayEntry(originals) &&
    originals.every(
      (boundary, index) =>
        Number.isFinite(boundary) &&
        boundary > (index === 0 ? timing.sessionStartTime : originals[index - 1]) &&
        boundary <= timing.endedAt,
    );
  if (
    !Array.isArray(originals) ||
    !Array.isArray(offsets) ||
    originals.length !== currentBoundaries.length ||
    offsets.length !== currentBoundaries.length ||
    !originalsAreMonotonicAndInSession ||
    !hasEveryArrayEntry(offsets) ||
    !offsets.every((offset, index) =>
      Number.isInteger(offset) &&
      offset % LAP_TRIM_STEP_MS === 0 &&
      Math.abs(offset) <= MAX_LAP_TRIM_MS &&
      originals[index] + offset === currentBoundaries[index]
    )
  ) {
    throw new RangeError(
      "Original lap boundaries must be monotonic and in session; trim offsets must be 0.1 second steps matching current timing.",
    );
  }

  const copiedSamples = copySessionSamples(samples, timing);
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
  const lapStats = Object.freeze(laps.map((lap) => {
    const assignedSamples = copiedSamples.filter(
      (sample) => sample.lap.completed && sample.lap.index === lap.index,
    );
    const aggregate = aggregateSamples(assignedSamples, timing);
    return Object.freeze({
      index: lap.index,
      sampleCount: assignedSamples.length,
      stats: Object.freeze({
        maxSpeedMph: aggregate.maxSpeedMph,
        averageSpeedMph: aggregate.averageSpeedMph,
        maxLeanLeftDegrees: aggregate.maxLeanLeftDegrees,
        maxLeanRightDegrees: aggregate.maxLeanRightDegrees,
      }),
    });
  }));
  const lastBoundary = currentBoundaries.at(-1) ?? timing.sessionStartTime;
  const originalLastBoundary = originals.at(-1) ?? timing.sessionStartTime;

  return Object.freeze({
    runId,
    riderId,
    runNumber,
    startedAt: timing.sessionStartTime,
    endedAt: timing.endedAt,
    startedAtUnixMs,
    endedAtUnixMs,
    totalDurationMs: timing.endedAt - timing.sessionStartTime,
    lapCount: laps.length,
    laps,
    lapStats,
    bestLap,
    trim: Object.freeze({
      stepMs: LAP_TRIM_STEP_MS,
      maxOffsetMs: MAX_LAP_TRIM_MS,
      originalBoundaries: Object.freeze([...originals]),
      offsetsMs: Object.freeze([...offsets]),
    }),
    unfinishedLap: Object.freeze({
      index: laps.length + 1,
      startTime: lastBoundary,
      originalStartTime: originalLastBoundary,
      duration: timing.endedAt - lastBoundary,
    }),
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

function requireTrimmedReport(report, lapIndex) {
  if (!report || !Object.isFrozen(report) || !report.trim || !Array.isArray(report.laps)) {
    throw new TypeError("An immutable run report with lap boundaries is required.");
  }
  if (!Number.isInteger(lapIndex) || lapIndex < 1 || lapIndex > report.laps.length) {
    throw new RangeError("Lap index must identify a completed lap.");
  }
}

function canMoveBoundary(report, lapIndex, adjustmentMs) {
  const boundaryIndex = lapIndex - 1;
  const nextOffset = report.trim.offsetsMs[boundaryIndex] + adjustmentMs;
  if (Math.abs(nextOffset) > report.trim.maxOffsetMs) return false;

  const candidate = report.trim.originalBoundaries[boundaryIndex] + nextOffset;
  const previousBoundary = boundaryIndex === 0
    ? report.startedAt
    : report.laps[boundaryIndex - 1].endTime;
  const isFinalBoundary = boundaryIndex === report.laps.length - 1;
  const nextBoundary = isFinalBoundary
    ? report.endedAt
    : report.laps[boundaryIndex + 1].endTime;
  const restoresOriginalSessionEnd =
    isFinalBoundary && candidate === nextBoundary && nextOffset === 0;
  return candidate > previousBoundary &&
    (candidate < nextBoundary || restoresOriginalSessionEnd);
}

/** Returns the exact enabled state for one lap row's boundary step controls. */
export function lapTrimControls(report, lapIndex) {
  requireTrimmedReport(report, lapIndex);
  const offsetMs = report.trim.offsetsMs[lapIndex - 1];
  return Object.freeze({
    offsetMs,
    canDecrease: canMoveBoundary(report, lapIndex, -LAP_TRIM_STEP_MS),
    canIncrease: canMoveBoundary(report, lapIndex, LAP_TRIM_STEP_MS),
  });
}

/** Returns the same report for a stale/rapid activation that is no longer enabled. */
export function adjustLapBoundaryIfAllowed(report, lapIndex, adjustmentMs) {
  requireTrimmedReport(report, lapIndex);
  if (adjustmentMs !== -LAP_TRIM_STEP_MS && adjustmentMs !== LAP_TRIM_STEP_MS) {
    throw new RangeError("A lap boundary adjustment must be exactly one 0.1 second step.");
  }
  return canMoveBoundary(report, lapIndex, adjustmentMs)
    ? adjustLapBoundary(report, lapIndex, adjustmentMs)
    : report;
}

/**
 * Moves one original tap boundary by exactly one 0.1 s step. Interior moves
 * transfer the same duration between adjacent laps; the final completed-lap
 * boundary transfers it against the unfinished tail. Session duration is fixed.
 */
export function adjustLapBoundary(report, lapIndex, adjustmentMs) {
  requireTrimmedReport(report, lapIndex);
  if (adjustmentMs !== -LAP_TRIM_STEP_MS && adjustmentMs !== LAP_TRIM_STEP_MS) {
    throw new RangeError("A lap boundary adjustment must be exactly one 0.1 second step.");
  }
  if (!canMoveBoundary(report, lapIndex, adjustmentMs)) {
    throw new RangeError("That lap boundary cannot move farther in this direction.");
  }

  const offsets = [...report.trim.offsetsMs];
  offsets[lapIndex - 1] += adjustmentMs;
  const boundaries = report.trim.originalBoundaries.map(
    (boundary, index) => boundary + offsets[index],
  );
  let startTime = report.startedAt;
  const laps = boundaries.map((endTime, index) => {
    const next = {
      index: index + 1,
      startTime,
      endTime,
      duration: endTime - startTime,
    };
    startTime = endTime;
    return next;
  });
  const timing = {
    sessionStartTime: report.startedAt,
    currentLapStartTime: startTime,
    lapNumber: laps.length + 1,
    laps,
    endedAt: report.endedAt,
  };

  return aggregateRunReport(
    { timing, samples: report.samples },
    {
      runNumber: report.runNumber,
      runId: report.runId,
      riderId: report.riderId,
      originalLapBoundaries: report.trim.originalBoundaries,
      lapTrimOffsets: offsets,
      startedAtUnixMs: report.startedAtUnixMs,
      endedAtUnixMs: report.endedAtUnixMs,
    },
  );
}
