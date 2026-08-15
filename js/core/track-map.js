const EARTH_RADIUS_METERS = 6_371_000;
const MAX_PLAUSIBLE_GPS_SPEED_MPS = 100;
const MIN_OUTLIER_JUMP_METERS = 100;

export const TRACK_VIEWBOX = Object.freeze({ width: 320, height: 160, padding: 14 });
export const MIN_TRACK_SPAN_METERS = 15;
export const SPEED_LOW_COLOR = "#55aaff";
export const SPEED_HIGH_COLOR = "#b6ff2e";
export const LEAN_LEFT_COLOR = "#62b6ff";
export const LEAN_RIGHT_COLOR = "#ff8a4c";
export const LEAN_LEVEL_COLOR = "#f4f6f2";
export const TRACK_NEUTRAL_COLOR = "#7d847b";

function validPosition(sample) {
  return sample &&
    Number.isFinite(sample.latitude) && sample.latitude >= -90 && sample.latitude <= 90 &&
    Number.isFinite(sample.longitude) && sample.longitude >= -180 && sample.longitude <= 180;
}

function longitudeDelta(from, to) {
  let delta = to - from;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function distanceMeters(first, second) {
  const meanLatitude = ((first.latitude + second.latitude) / 2) * Math.PI / 180;
  const north = (second.latitude - first.latitude) * Math.PI / 180 * EARTH_RADIUS_METERS;
  const east = longitudeDelta(first.longitude, second.longitude) * Math.PI / 180 *
    EARTH_RADIUS_METERS * Math.cos(meanLatitude);
  return Math.hypot(east, north);
}

function allowedJumpMeters(first, second) {
  const elapsedSeconds = Number.isFinite(first.timestamp) && Number.isFinite(second.timestamp)
    ? Math.max(0, second.timestamp - first.timestamp) / 1_000
    : 0;
  return Math.max(MIN_OUTLIER_JUMP_METERS, elapsedSeconds * MAX_PLAUSIBLE_GPS_SPEED_MPS);
}

function plausibleJump(first, second) {
  return distanceMeters(first, second) <= allowedJumpMeters(first, second);
}

/**
 * Removes isolated teleports, then keeps the longest physically contiguous GPS
 * chain. This rejects fixes that would otherwise flatten the useful circuit
 * into a corner without smoothing or changing the rider's recorded line.
 */
export function filterGpsOutliers(samples) {
  if (!Array.isArray(samples)) throw new TypeError("Track samples must be an array.");
  const positioned = samples.filter(validPosition);
  // Instrument samples repeat the latest native fix at 20 Hz. Keep the first
  // sample at each coordinate so plausibility uses time between native fixes,
  // not the final 50 ms repeat before the next fix arrives.
  const fixes = positioned.filter((point, index, points) =>
    index === 0 ||
    point.latitude !== points[index - 1].latitude ||
    point.longitude !== points[index - 1].longitude);
  if (fixes.length < 2) {
    return Object.freeze({
      points: Object.freeze([...fixes]),
      validPointCount: positioned.length,
      rejectedCount: 0,
    });
  }

  const withoutIsolatedTeleports = [];
  for (let index = 0; index < fixes.length; index += 1) {
    const previous = fixes[index - 1];
    const current = fixes[index];
    const next = fixes[index + 1];
    const isolated = previous && next &&
      !plausibleJump(previous, current) &&
      !plausibleJump(current, next) &&
      plausibleJump(previous, next);
    if (!isolated) withoutIsolatedTeleports.push(current);
  }

  const chains = [[]];
  for (const point of withoutIsolatedTeleports) {
    const chain = chains.at(-1);
    if (chain.length > 0 && !plausibleJump(chain.at(-1), point)) chains.push([]);
    chains.at(-1).push(point);
  }
  // Repeatedly bridge good chains around an intervening outlier plateau. A
  // restart after every merge lets good/bad/good/bad/good reconnect fully.
  let reconnected = true;
  while (reconnected) {
    reconnected = false;
    for (let index = 0; index + 2 < chains.length; index += 1) {
      if (!plausibleJump(chains[index].at(-1), chains[index + 2][0])) continue;
      chains.splice(index, 3, [...chains[index], ...chains[index + 2]]);
      reconnected = true;
      break;
    }
  }
  const points = chains.reduce((longest, chain) =>
    chain.length > longest.length ? chain : longest, []);

  return Object.freeze({
    points: Object.freeze([...points]),
    validPointCount: positioned.length,
    rejectedCount: fixes.length - points.length,
  });
}

function projectedMeters(points) {
  const reference = points[0];
  const cosine = Math.cos(reference.latitude * Math.PI / 180);
  return points.map((sample) => Object.freeze({
    sample,
    east: longitudeDelta(reference.longitude, sample.longitude) * Math.PI / 180 *
      EARTH_RADIUS_METERS * cosine,
    north: (sample.latitude - reference.latitude) * Math.PI / 180 * EARTH_RADIUS_METERS,
  }));
}

/** Auto-fits a trace with one uniform scale, preserving its geographic aspect ratio. */
export function projectTrackPoints(points, viewbox = TRACK_VIEWBOX) {
  if (!Array.isArray(points) || points.length < 2 || !points.every(validPosition)) {
    throw new TypeError("At least two valid GPS points are required for projection.");
  }
  const projected = projectedMeters(points);
  const eastValues = projected.map(({ east }) => east);
  const northValues = projected.map(({ north }) => north);
  const minEast = Math.min(...eastValues);
  const maxEast = Math.max(...eastValues);
  const minNorth = Math.min(...northValues);
  const maxNorth = Math.max(...northValues);
  const spanEast = maxEast - minEast;
  const spanNorth = maxNorth - minNorth;
  const geographicSpanMeters = Math.hypot(spanEast, spanNorth);
  const innerWidth = viewbox.width - viewbox.padding * 2;
  const innerHeight = viewbox.height - viewbox.padding * 2;
  const scale = Math.min(
    spanEast === 0 ? Number.POSITIVE_INFINITY : innerWidth / spanEast,
    spanNorth === 0 ? Number.POSITIVE_INFINITY : innerHeight / spanNorth,
  );
  const finiteScale = Number.isFinite(scale) ? scale : 0;
  const drawnWidth = spanEast * finiteScale;
  const drawnHeight = spanNorth * finiteScale;
  const offsetX = (viewbox.width - drawnWidth) / 2;
  const offsetY = (viewbox.height - drawnHeight) / 2;

  return Object.freeze({
    geographicSpanMeters,
    spanEastMeters: spanEast,
    spanNorthMeters: spanNorth,
    scale: finiteScale,
    points: Object.freeze(projected.map(({ sample, east, north }) => Object.freeze({
      sample,
      x: offsetX + (east - minEast) * finiteScale,
      y: viewbox.height - offsetY - (north - minNorth) * finiteScale,
    }))),
  });
}

function parseHex(color) {
  return [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));
}

function interpolateColor(from, to, fraction) {
  const start = parseHex(from);
  const end = parseHex(to);
  return `#${start.map((channel, index) =>
    Math.round(channel + (end[index] - channel) * fraction).toString(16).padStart(2, "0")
  ).join("")}`;
}

/** Maps speed across this session's own finite range. */
export function colorForSpeed(speedMph, minimumSpeedMph, maximumSpeedMph) {
  if (!Number.isFinite(speedMph) || !Number.isFinite(minimumSpeedMph) ||
      !Number.isFinite(maximumSpeedMph)) return TRACK_NEUTRAL_COLOR;
  if (maximumSpeedMph <= minimumSpeedMph) return SPEED_HIGH_COLOR;
  const fraction = Math.max(0, Math.min(1,
    (speedMph - minimumSpeedMph) / (maximumSpeedMph - minimumSpeedMph)));
  return interpolateColor(SPEED_LOW_COLOR, SPEED_HIGH_COLOR, fraction);
}

/** Uses categorically different hues so signed left/right lean is unmistakable. */
export function colorForLean(leanDegrees) {
  if (!Number.isFinite(leanDegrees)) return TRACK_NEUTRAL_COLOR;
  if (leanDegrees < -0.5) return LEAN_LEFT_COLOR;
  if (leanDegrees > 0.5) return LEAN_RIGHT_COLOR;
  return LEAN_LEVEL_COLOR;
}

function averageAvailable(first, second, field, predicate = Number.isFinite) {
  const values = [first[field], second[field]].filter(predicate);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function projectedTopSpeedPoint(points, topSpeedPoint) {
  const position = topSpeedPoint?.position;
  if (!Number.isFinite(topSpeedPoint?.timestamp) || !validPosition(position)) return null;
  // Matching the retained coordinate is deliberate: a top-speed sample may be
  // a 20 Hz repeat of a retained native fix, but a rejected GPS teleport must
  // never be silently moved to another point on the trace.
  return points.find(({ sample }) =>
    sample.latitude === position.latitude && sample.longitude === position.longitude) ?? null;
}

/** Builds all pure geometry and color data needed by the tile-free SVG renderer. */
export function createTrackMapModel(samples, topSpeedPoint = null) {
  const filtered = filterGpsOutliers(samples);
  if (filtered.validPointCount === 0) {
    return Object.freeze({ state: "no-fix", message: "NO GPS FIX RECORDED", ...filtered });
  }
  if (filtered.points.length < 2) {
    const stationary = filtered.validPointCount >= 2;
    return Object.freeze({
      state: stationary ? "stationary" : "too-few",
      message: stationary ? "STATIONARY TRACE · NO TRACK PATH" : "TOO FEW GPS POINTS · NO PATH",
      ...filtered,
    });
  }

  const extentProjection = projectTrackPoints(filtered.points);
  if (extentProjection.geographicSpanMeters < MIN_TRACK_SPAN_METERS) {
    return Object.freeze({ state: "stationary", message: "STATIONARY TRACE · NO TRACK PATH", ...filtered });
  }

  // Instrument capture is faster than native GPS, so many adjacent samples
  // carry the exact same fix. One point per coordinate change preserves the
  // recorded polyline while keeping a long report's SVG compact.
  const drawingPoints = filtered.points.filter((point, index, points) =>
    index === 0 ||
    point.latitude !== points[index - 1].latitude ||
    point.longitude !== points[index - 1].longitude);
  const projection = projectTrackPoints(drawingPoints);
  const speeds = filtered.points
    .filter((point) => point.speedValid === true && Number.isFinite(point.speedMph) && point.speedMph >= 0)
    .map((point) => point.speedMph);
  const speedRange = Object.freeze({
    minimum: speeds.length === 0 ? null : Math.min(...speeds),
    maximum: speeds.length === 0 ? null : Math.max(...speeds),
  });
  const segments = [];
  for (let index = 1; index < projection.points.length; index += 1) {
    const from = projection.points[index - 1];
    const to = projection.points[index];
    const segmentSpeeds = [from.sample, to.sample]
      .filter((sample) => sample.speedValid === true && Number.isFinite(sample.speedMph) && sample.speedMph >= 0)
      .map((sample) => sample.speedMph);
    const speedMph = segmentSpeeds.length === 0
      ? null
      : segmentSpeeds.reduce((sum, value) => sum + value, 0) / segmentSpeeds.length;
    const leanDegrees = averageAvailable(from.sample, to.sample, "leanDegrees");
    segments.push(Object.freeze({
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      speedColor: colorForSpeed(speedMph, speedRange.minimum, speedRange.maximum),
      leanColor: colorForLean(leanDegrees),
    }));
  }
  const markerPoint = projectedTopSpeedPoint(projection.points, topSpeedPoint);
  const marker = markerPoint === null
    ? null
    : Object.freeze({
        x: markerPoint.x,
        y: markerPoint.y,
        topSpeedTimestamp: topSpeedPoint.timestamp,
      });

  return Object.freeze({
    state: "ready",
    message: "",
    ...filtered,
    speedRange,
    geographicSpanMeters: projection.geographicSpanMeters,
    projectedPoints: projection.points,
    segments: Object.freeze(segments),
    marker,
  });
}
