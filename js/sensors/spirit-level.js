const DEFAULT_MAX_TILT = 30;
const DEFAULT_MAX_OFFSET = 38;

/** Map DeviceOrientation tilt into the currently displayed screen axes. */
export function calculateBubbleOffset(
  { beta, gamma },
  { rotationDegrees = 0, maxTilt = DEFAULT_MAX_TILT, maxOffset = DEFAULT_MAX_OFFSET } = {},
) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  if (!(maxTilt > 0) || !(maxOffset >= 0)) {
    throw new RangeError("Spirit-level limits must be positive.");
  }

  const radians = (rotationDegrees * Math.PI) / 180;
  const rawX = gamma;
  const rawY = beta;
  const screenX = rawX * Math.cos(radians) + rawY * Math.sin(radians);
  const screenY = -rawX * Math.sin(radians) + rawY * Math.cos(radians);
  const magnitude = Math.hypot(screenX, screenY);
  const tiltScale = magnitude > maxTilt ? maxTilt / magnitude : 1;
  const pixelScale = maxOffset / maxTilt;

  return Object.freeze({
    x: screenX * tiltScale * pixelScale,
    y: screenY * tiltScale * pixelScale,
  });
}
