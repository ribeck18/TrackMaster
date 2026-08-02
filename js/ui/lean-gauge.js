const PIVOT = Object.freeze({ x: 200, y: 210 });
const ARC_RADIUS = 182;
const NEEDLE_RADIUS = 116;
const GAUGE_LIMIT_DEGREES = 52;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function gaugePoint(radius, degrees) {
  if (!Number.isFinite(radius) || !Number.isFinite(degrees)) {
    throw new TypeError("Gauge geometry requires finite radius and angle values.");
  }
  const radians = (degrees * Math.PI) / 180;
  return Object.freeze({
    x: PIVOT.x + radius * Math.sin(radians),
    y: PIVOT.y - radius * Math.cos(radians),
  });
}

export function leanGaugeGeometry(signedLeanDegrees) {
  if (!Number.isFinite(signedLeanDegrees)) {
    throw new TypeError("Lean angle must be finite.");
  }
  const gaugeDegrees = clamp(signedLeanDegrees, -GAUGE_LIMIT_DEGREES, GAUGE_LIMIT_DEGREES);
  const arcStart = gaugePoint(ARC_RADIUS, 0);
  const arcEnd = gaugePoint(ARC_RADIUS, gaugeDegrees);
  const needleEnd = gaugePoint(NEEDLE_RADIUS, gaugeDegrees);
  // Keep command topology stable at zero and across directions so browsers
  // can interpolate the active path rather than switching A/L command shapes.
  const activePath = `M ${arcStart.x} ${arcStart.y} A ${ARC_RADIUS} ${ARC_RADIUS} 0 0 ${gaugeDegrees >= 0 ? 1 : 0} ${arcEnd.x} ${arcEnd.y}`;

  return Object.freeze({
    signedLeanDegrees,
    gaugeDegrees,
    activePath,
    needleEnd,
    numericDegrees: Math.round(Math.abs(signedLeanDegrees)),
    direction: Math.abs(signedLeanDegrees) < 1 ? "LEVEL" : signedLeanDegrees < 0 ? "LEFT" : "RIGHT",
  });
}

export function createLeanGaugeRenderer(root) {
  if (!root?.querySelector) throw new TypeError("Lean gauge renderer requires a DOM root.");
  const activeArc = root.querySelector(".gauge-active");
  const needle = root.querySelector(".gauge-needle");
  const value = root.querySelector(".lean-value");
  const direction = root.querySelector(".lean-direction");
  const description = root.querySelector(".lean-gauge desc");
  if (!activeArc || !needle || !value || !direction) {
    throw new Error("Lean gauge markup is incomplete.");
  }

  function render(signedLeanDegrees) {
    if (!Number.isFinite(signedLeanDegrees)) {
      value.textContent = "N/A";
      value.setAttribute("aria-label", "Lean angle unavailable");
      direction.textContent = "N/A";
      activeArc.setAttribute("d", "M 200 28 A 182 182 0 0 1 200 28");
      needle.setAttribute("x2", "200");
      needle.setAttribute("y2", "94");
      if (description) description.textContent = "Lean angle unavailable";
      return;
    }

    const geometry = leanGaugeGeometry(signedLeanDegrees);
    activeArc.setAttribute("d", geometry.activePath);
    needle.setAttribute("x2", geometry.needleEnd.x.toFixed(3));
    needle.setAttribute("y2", geometry.needleEnd.y.toFixed(3));
    value.textContent = `${geometry.numericDegrees}°`;
    value.setAttribute(
      "aria-label",
      geometry.direction === "LEVEL"
        ? `Lean angle ${geometry.numericDegrees} degrees, level`
        : `Lean angle ${geometry.numericDegrees} degrees ${geometry.direction.toLowerCase()}`,
    );
    direction.textContent = geometry.direction;
    if (description) {
      description.textContent =
        geometry.direction === "LEVEL"
          ? `${geometry.numericDegrees} degrees and level`
          : `${geometry.numericDegrees} degrees ${geometry.direction.toLowerCase()}`;
    }
  }

  return Object.freeze({ render });
}
