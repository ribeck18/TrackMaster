import { formatLapTime } from "../core/lap-timing.js";
import { LAP_TRIM_STEP_MS, lapTrimControls } from "../core/report.js";
import { createTrackMapModel, TRACK_VIEWBOX } from "../core/track-map.js";

const activeRenderTokens = new WeakMap();

function displayNumber(value) {
  return value === null ? "--" : String(Math.round(value));
}

function formatTopSpeedContext(point) {
  if (point === null) return "NO SPEED DATA";
  const elapsedSeconds = Math.max(0, Math.floor(point.lap.elapsedMs / 1_000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `LAP ${point.lap.index} · ${minutes}:${String(seconds).padStart(2, "0")} INTO LAP`;
}

function createTrimButton({ label, ariaLabel, disabled, adjustmentMs, lap, onTrim }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "lap-trim-button";
  button.textContent = label;
  button.disabled = disabled;
  button.dataset.trimLap = String(lap.index);
  button.dataset.trimAdjustment = String(adjustmentMs);
  button.setAttribute("aria-label", ariaLabel);
  button.addEventListener("click", () => {
    if (!button.disabled) onTrim?.(lap.index, adjustmentMs);
  });
  return button;
}

function createLapRow(lap, report, onTrim, expanded, onToggle) {
  const row = document.createElement("div");
  row.className = `report-lap${lap.isBest ? " report-lap--best" : ""}`;

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "report-lap__summary";
  summary.dataset.lapSummary = String(lap.index);
  const controlsId = `lap-${lap.index}-trim-controls`;
  summary.setAttribute("aria-controls", controlsId);

  const label = document.createElement("span");
  label.textContent = `LAP ${lap.index}${lap.isBest ? " · BEST" : ""}`;
  const duration = document.createElement("output");
  duration.textContent = formatLapTime(lap.duration);
  duration.setAttribute("aria-label", `Lap ${lap.index} time ${duration.textContent}`);
  summary.append(label, duration);

  const controlsState = lapTrimControls(report, lap.index);
  const controls = document.createElement("div");
  controls.id = controlsId;
  controls.className = "lap-trim-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute(
    "aria-label",
    lap.index === report.lapCount
      ? `Lap ${lap.index} end boundary trim; adjusts the unfinished tail`
      : `Lap ${lap.index} end boundary trim; adjusts laps ${lap.index} and ${lap.index + 1} equally`,
  );

  const trimStatus = document.createElement("output");
  const signedOffset = controlsState.offsetMs > 0
    ? `+${(controlsState.offsetMs / 1_000).toFixed(1)}`
    : (controlsState.offsetMs / 1_000).toFixed(1);
  trimStatus.textContent = `TAP ${signedOffset}S`;
  trimStatus.setAttribute("aria-label", `Boundary offset ${signedOffset} seconds from original tap`);

  controls.append(
    createTrimButton({
      label: "−",
      ariaLabel: `Move lap ${lap.index} end boundary earlier by 0.1 seconds`,
      disabled: !controlsState.canDecrease,
      adjustmentMs: -LAP_TRIM_STEP_MS,
      lap,
      onTrim,
    }),
    trimStatus,
    createTrimButton({
      label: "+",
      ariaLabel: `Move lap ${lap.index} end boundary later by 0.1 seconds`,
      disabled: !controlsState.canIncrease,
      adjustmentMs: LAP_TRIM_STEP_MS,
      lap,
      onTrim,
    }),
  );

  function setExpanded(nextExpanded) {
    summary.setAttribute("aria-expanded", String(nextExpanded));
    summary.setAttribute(
      "aria-label",
      `Lap ${lap.index}, ${formatLapTime(lap.duration)}. ${nextExpanded ? "Hide" : "Show"} boundary trim controls.`,
    );
    controls.hidden = !nextExpanded;
  }

  setExpanded(expanded);
  summary.addEventListener("click", () => {
    const nextExpanded = summary.getAttribute("aria-expanded") !== "true";
    onToggle(lap.index, nextExpanded);
  });
  row.append(summary, controls);
  return Object.freeze({ row, setExpanded, summary, controls });
}

function focusAfterTrim(root, report, focusTrim) {
  if (focusTrim === null) return;
  const { lapIndex, adjustmentMs } = focusTrim;
  const controls = lapTrimControls(report, lapIndex);
  const sameDirectionEnabled = adjustmentMs < 0 ? controls.canDecrease : controls.canIncrease;
  const target = sameDirectionEnabled
    ? root.querySelector(
        `[data-trim-lap="${lapIndex}"][data-trim-adjustment="${adjustmentMs}"]`,
      )
    : root.querySelector(`[data-lap-summary="${lapIndex}"]`);
  target?.focus({ preventScroll: true });
}

function createSvgElement(name) {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}

function renderTrackMap(root, report, renderToken) {
  const map = root.querySelector("[data-report-map]");
  const model = createTrackMapModel(report.samples, report.topSpeedPoint);
  map.replaceChildren();
  map.dataset.location = model.state === "no-fix" ? "unavailable" : "available";
  map.dataset.trackState = model.state;

  if (model.state !== "ready") {
    map.disabled = true;
    delete map.dataset.trackMode;
    delete root.dataset.trackMode;
    map.setAttribute("aria-label", model.message);
    const state = document.createElement("span");
    state.className = "report-map__state";
    state.dataset.mapState = "";
    state.textContent = model.message;
    map.append(state);
    return model;
  }

  map.disabled = false;
  const svg = createSvgElement("svg");
  svg.classList?.add("report-map__trace");
  svg.setAttribute("viewBox", `0 0 ${TRACK_VIEWBOX.width} ${TRACK_VIEWBOX.height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("aria-hidden", "true");

  const underlay = createSvgElement("polyline");
  underlay.classList?.add("report-map__underlay");
  underlay.setAttribute("points", model.projectedPoints.map(({ x, y }) => `${x},${y}`).join(" "));
  svg.append(underlay);

  const segmentElements = model.segments.map((segment) => {
    const line = createSvgElement("line");
    line.classList?.add("report-map__segment");
    line.setAttribute("x1", segment.x1);
    line.setAttribute("y1", segment.y1);
    line.setAttribute("x2", segment.x2);
    line.setAttribute("y2", segment.y2);
    line.dataset.speedColor = segment.speedColor;
    line.dataset.leanColor = segment.leanColor;
    svg.append(line);
    return line;
  });

  if (model.marker !== null) {
    const marker = createSvgElement("circle");
    marker.classList?.add("report-map__marker");
    marker.dataset.topSpeedMarker = "";
    marker.dataset.topSpeedTimestamp = String(model.marker.topSpeedTimestamp);
    marker.setAttribute("cx", model.marker.x);
    marker.setAttribute("cy", model.marker.y);
    marker.setAttribute("r", 5);
    svg.append(marker);
  }

  const modeLabel = document.createElement("span");
  modeLabel.className = "report-map__mode";
  modeLabel.dataset.mapMode = "";
  const state = document.createElement("span");
  state.className = "visually-hidden";
  state.dataset.mapState = "";
  state.textContent = "TRACK TRACE READY";
  map.append(svg, modeLabel, state);

  let mode = root.dataset.trackMode === "lean" ? "lean" : "speed";
  function updateMode() {
    root.dataset.trackMode = mode;
    map.dataset.trackMode = mode;
    const speedMode = mode === "speed";
    modeLabel.textContent = speedMode ? "COLOR · SPEED · TAP FOR LEAN" : "COLOR · LEAN L/R · TAP FOR SPEED";
    map.setAttribute(
      "aria-label",
      speedMode
        ? "Track trace colored by session-relative speed. Tap for left and right lean colors."
        : "Track trace colored by left and right lean. Tap for speed colors.",
    );
    for (const line of segmentElements) {
      line.setAttribute("stroke", speedMode ? line.dataset.speedColor : line.dataset.leanColor);
    }
  }
  updateMode();
  map.addEventListener("click", () => {
    if (activeRenderTokens.get(root) !== renderToken) return;
    mode = mode === "speed" ? "lean" : "speed";
    updateMode();
  });
  return model;
}

/** Renders a completed immutable report snapshot into the report screen. */
export function renderRunReport(root, report, { onTrim = null, focusTrim = null } = {}) {
  if (!(root instanceof Element)) throw new TypeError("A report screen element is required.");
  if (!report || !Object.isFrozen(report)) throw new TypeError("An immutable report is required.");
  if (onTrim !== null && typeof onTrim !== "function") throw new TypeError("Lap trim callback must be a function.");

  const renderToken = Object.freeze({});
  activeRenderTokens.set(root, renderToken);

  root.querySelector("[data-report-meta]").textContent =
    `RUN ${report.runNumber} · ${report.lapCount} ${report.lapCount === 1 ? "LAP" : "LAPS"} · ${formatLapTime(report.totalDurationMs)} TOTAL`;
  root.querySelector("[data-report-best]").textContent =
    `BEST ${report.bestLap === null ? "--:--.-" : formatLapTime(report.bestLap.duration)}`;

  const lapRows = root.querySelector("[data-report-laps]");
  lapRows.replaceChildren();
  if (report.laps.length === 0) {
    delete root.dataset.expandedLap;
    const empty = document.createElement("p");
    empty.className = "report-empty";
    empty.textContent = "NO COMPLETED LAPS";
    lapRows.append(empty);
  } else {
    let expandedLap = Number(root.dataset.expandedLap);
    if (!Number.isInteger(expandedLap) || expandedLap < 1 || expandedLap > report.lapCount) {
      delete root.dataset.expandedLap;
      expandedLap = 0;
    }
    const rowViews = new Map();
    const toggleLap = (lapIndex, nextExpanded) => {
      // Detached summaries retain their listeners after a rerender. Ignore both
      // stale open and stale close activations before they can touch live state.
      if (activeRenderTokens.get(root) !== renderToken) return;
      const currentlyExpanded = Number(root.dataset.expandedLap);
      if (!nextExpanded) {
        rowViews.get(lapIndex)?.setExpanded(false);
        // A close can only clear the matching live expanded row.
        if (currentlyExpanded === lapIndex) delete root.dataset.expandedLap;
        return;
      }
      if (Number.isInteger(currentlyExpanded)) {
        rowViews.get(currentlyExpanded)?.setExpanded(false);
      }
      root.dataset.expandedLap = String(lapIndex);
      rowViews.get(lapIndex)?.setExpanded(true);
    };
    for (const lap of report.laps) {
      const view = createLapRow(lap, report, onTrim, lap.index === expandedLap, toggleLap);
      rowViews.set(lap.index, view);
      lapRows.append(view.row);
    }
  }

  root.querySelector("[data-report-max-speed]").textContent = displayNumber(report.stats.maxSpeedMph);
  root.querySelector("[data-report-avg-speed]").textContent = displayNumber(report.stats.averageSpeedMph);
  root.querySelector("[data-report-left-lean]").textContent =
    report.stats.maxLeanLeftDegrees === null ? "--" : `${Math.round(report.stats.maxLeanLeftDegrees)}°`;
  root.querySelector("[data-report-right-lean]").textContent =
    report.stats.maxLeanRightDegrees === null ? "--" : `${Math.round(report.stats.maxLeanRightDegrees)}°`;

  renderTrackMap(root, report, renderToken);

  const point = report.topSpeedPoint;
  root.querySelector("[data-top-speed]").textContent = `${displayNumber(point?.speedMph ?? null)} MPH`;
  root.querySelector("[data-top-speed-context]").textContent = formatTopSpeedContext(point);

  root.querySelector("[data-save-status]").textContent = "";
  focusAfterTrim(root, report, focusTrim);
}
