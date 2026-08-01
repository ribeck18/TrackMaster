import test from "node:test";
import assert from "node:assert/strict";

import { calculateBubbleOffset } from "../js/sensors/spirit-level.js";

test("a level phone puts the live bubble exactly in the centre", () => {
  assert.deepEqual(calculateBubbleOffset({ beta: 0, gamma: 0 }), { x: 0, y: 0 });
});

test("device tilt moves the bubble on both screen axes", () => {
  assert.deepEqual(
    calculateBubbleOffset(
      { beta: -15, gamma: 7.5 },
      { maxTilt: 30, maxOffset: 40 },
    ),
    { x: 10, y: -20 },
  );
});

test("portrait CSS rotation maps natural device axes into landscape pixels", () => {
  const offset = calculateBubbleOffset(
    { beta: 15, gamma: 0 },
    { rotationDegrees: 90, maxTilt: 30, maxOffset: 40 },
  );

  assert.ok(Math.abs(offset.x - 20) < 1e-10);
  assert.ok(Math.abs(offset.y) < 1e-10);
});

test("bubble travel clamps by vector magnitude to the circular edge", () => {
  const offset = calculateBubbleOffset(
    { beta: -90, gamma: 80 },
    { maxTilt: 30, maxOffset: 38 },
  );

  assert.ok(Math.abs(Math.hypot(offset.x, offset.y) - 38) < 1e-10);
  assert.ok(Math.abs(offset.x / offset.y - 80 / -90) < 1e-10);
});

test("diagonal tilt cannot escape the circular spirit-level boundary", () => {
  const offset = calculateBubbleOffset(
    { beta: 30, gamma: 30 },
    { maxTilt: 30, maxOffset: 40 },
  );

  assert.ok(Math.abs(offset.x - Math.SQRT1_2 * 40) < 1e-10);
  assert.ok(Math.abs(offset.y - Math.SQRT1_2 * 40) < 1e-10);
  assert.ok(Math.hypot(offset.x, offset.y) <= 40);
});

test("invalid samples are ignored and invalid geometry is rejected", () => {
  assert.equal(calculateBubbleOffset({ beta: null, gamma: 0 }), null);
  assert.throws(
    () => calculateBubbleOffset({ beta: 0, gamma: 0 }, { maxTilt: 0 }),
    /limits must be positive/,
  );
});
