import test from "node:test";
import assert from "node:assert/strict";

import {
  LEAN_LEFT_COLOR,
  LEAN_RIGHT_COLOR,
  MIN_TRACK_SPAN_METERS,
  SPEED_HIGH_COLOR,
  SPEED_LOW_COLOR,
  colorForLean,
  colorForSpeed,
  createTrackMapModel,
  filterGpsOutliers,
  projectTrackPoints,
} from "../js/core/track-map.js";

function point(timestamp, latitude, longitude, speedMph = 50, leanDegrees = 0) {
  return { timestamp, latitude, longitude, speedMph, speedValid: true, leanDegrees };
}

test("projection auto-fits with one scale so circuit aspect ratio is preserved", () => {
  const projection = projectTrackPoints([
    point(0, 0, 0),
    point(1_000, 0.001, 0.002),
  ]);
  const [first, second] = projection.points;
  const screenEastScale = Math.abs(second.x - first.x) / projection.spanEastMeters;
  const screenNorthScale = Math.abs(second.y - first.y) / projection.spanNorthMeters;

  assert.ok(Math.abs(screenEastScale - screenNorthScale) < 1e-12);
  assert.ok(first.x >= 14 && first.x <= 306);
  assert.ok(second.y >= 14 && second.y <= 146);
  assert.ok(second.y < first.y, "north is rendered upward");
});

test("isolated GPS teleport is removed before fitting the useful trace", () => {
  const trace = [
    point(0, 37, -122),
    point(1_000, 37.0001, -121.9999),
    point(2_000, 38, -121),
    point(3_000, 37.0002, -121.9998),
    point(4_000, 37.0003, -121.9997),
  ];
  const filtered = filterGpsOutliers(trace);
  const model = createTrackMapModel(trace, { timestamp: 4_000 });

  assert.equal(filtered.rejectedCount, 1);
  assert.deepEqual(filtered.points.map(({ timestamp }) => timestamp), [0, 1_000, 3_000, 4_000]);
  assert.equal(model.state, "ready");
  assert.ok(model.geographicSpanMeters < 100, "the teleport cannot dominate auto-fit bounds");
});

test("179 MPH movement at two-second native GPS cadence survives repeated 20 Hz coordinates", () => {
  const metresPerSecond = 179 * 0.44704;
  const latitudeDelta = (metresPerSecond * 2) / 111_195;
  const trace = [point(0, 37, -122, 179)];
  for (let timestamp = 50; timestamp < 2_000; timestamp += 50) {
    trace.push(point(timestamp, 37, -122, 179));
  }
  trace.push(point(2_000, 37 + latitudeDelta, -122, 179));

  const filtered = filterGpsOutliers(trace);
  const model = createTrackMapModel(trace);

  assert.deepEqual(filtered.points.map(({ timestamp }) => timestamp), [0, 2_000]);
  assert.equal(filtered.rejectedCount, 0);
  assert.equal(model.state, "ready");
  assert.equal(model.segments.length, 1);
});

test("multiple repeated outlier plateaus reconnect every valid suffix", () => {
  const trace = [
    point(0, 37, -122),
    point(200, 38, -121),
    point(300, 38.00001, -120.99999),
    point(1_000, 37.0003, -122),
    point(1_200, 36, -123),
    point(1_300, 35.99999, -123.00001),
    point(2_000, 37.0006, -122),
  ];
  const filtered = filterGpsOutliers(trace);

  assert.deepEqual(filtered.points.map(({ timestamp }) => timestamp), [0, 1_000, 2_000]);
  assert.equal(filtered.rejectedCount, 4);
});

test("a repeated bad-fix plateau is removed and the surrounding trace is reconnected", () => {
  const trace = [
    point(0, 37, -122),
    point(1_000, 37.0001, -121.9999),
    point(1_100, 38, -121),
    point(1_200, 38, -121),
    point(1_300, 38, -121),
    point(2_000, 37.0002, -121.9998),
    point(3_000, 37.0003, -121.9997),
  ];
  const filtered = filterGpsOutliers(trace);

  assert.deepEqual(filtered.points.map(({ timestamp }) => timestamp), [0, 1_000, 2_000, 3_000]);
  assert.equal(filtered.rejectedCount, 1, "one repeated native coordinate is rejected once");
});

test("speed colors use the session's own minimum and maximum", () => {
  assert.equal(colorForSpeed(20, 20, 100), SPEED_LOW_COLOR);
  assert.equal(colorForSpeed(100, 20, 100), SPEED_HIGH_COLOR);
  assert.notEqual(
    colorForSpeed(60, 20, 100),
    colorForSpeed(60, 0, 60),
    "the same speed changes color when the session range changes",
  );

  const model = createTrackMapModel([
    point(0, 37, -122, 20),
    point(1_000, 37.0002, -121.9998, 60),
    point(2_000, 37.0004, -121.9996, 100),
  ]);
  assert.deepEqual(model.speedRange, { minimum: 20, maximum: 100 });
  assert.notEqual(model.segments[0].speedColor, model.segments[1].speedColor);
});

test("signed lean colors distinguish left, level, and right", () => {
  assert.equal(colorForLean(-30), LEAN_LEFT_COLOR);
  assert.equal(colorForLean(30), LEAN_RIGHT_COLOR);
  assert.notEqual(colorForLean(-30), colorForLean(30));
  assert.notEqual(colorForLean(0), colorForLean(-30));
});

test("no fix, too few fixes, and stationary sessions have distinct degraded states", () => {
  assert.deepEqual(
    createTrackMapModel([]).state,
    "no-fix",
  );
  assert.equal(createTrackMapModel([point(0, 37, -122)]).state, "too-few");

  const stationaryLatitudeDelta = (MIN_TRACK_SPAN_METERS / 3) / 111_195;
  const stationary = createTrackMapModel([
    point(0, 37, -122, 0),
    point(1_000, 37 + stationaryLatitudeDelta, -122, 0),
    point(2_000, 37, -122, 0),
  ]);
  assert.equal(stationary.state, "stationary");
  assert.match(stationary.message, /STATIONARY/);
});

test("repeated instrument samples at one native fix do not create redundant SVG segments", () => {
  const model = createTrackMapModel([
    point(0, 37, -122, 20),
    point(50, 37, -122, 20),
    point(100, 37, -122, 20),
    point(1_000, 37.0002, -121.9998, 50),
    point(1_050, 37.0002, -121.9998, 50),
    point(2_000, 37.0004, -122, 80),
  ]);

  assert.equal(model.state, "ready");
  assert.equal(model.projectedPoints.length, 3);
  assert.equal(model.segments.length, 2);
});

test("projection wraps the antimeridian and applies high-latitude longitude scale", () => {
  const projection = projectTrackPoints([
    point(0, 60, 179.999),
    point(2_000, 60, -179.999),
  ]);

  assert.ok(projection.spanEastMeters > 100 && projection.spanEastMeters < 120);
  assert.ok(projection.geographicSpanMeters < 120, "trace does not span the long way around Earth");
});

test("filtered-out top-speed coordinates never clamp the marker to another trace point", () => {
  const trace = [
    point(0, 37, -122, 30),
    point(1_000, 38, -121, 120),
    point(2_000, 37.0003, -122, 50),
  ];
  const model = createTrackMapModel(trace, {
    timestamp: 1_000,
    position: { latitude: 38, longitude: -121 },
  });

  assert.equal(model.state, "ready");
  assert.equal(model.marker, null);
});

test("top-speed marker uses the projected retained GPS coordinate", () => {
  const trace = [
    point(0, 37, -122, 30),
    point(1_000, 37.0002, -121.9998, 100),
    point(2_000, 37.0004, -122, 50),
  ];
  const model = createTrackMapModel(trace, {
    timestamp: 1_000,
    position: { latitude: 37.0002, longitude: -121.9998 },
  });
  const projectedTop = model.projectedPoints.find(({ sample }) => sample.timestamp === 1_000);

  assert.deepEqual(model.marker, {
    x: projectedTop.x,
    y: projectedTop.y,
    topSpeedTimestamp: 1_000,
  });
});
