import { formatLapTime } from "../core/lap-timing.js";

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

function createLapRow(lap) {
  const row = document.createElement("div");
  row.className = `report-lap${lap.isBest ? " report-lap--best" : ""}`;

  const label = document.createElement("span");
  label.textContent = `LAP ${lap.index}${lap.isBest ? " · BEST" : ""}`;
  const duration = document.createElement("output");
  duration.textContent = formatLapTime(lap.duration);
  duration.setAttribute("aria-label", `Lap ${lap.index} time ${duration.textContent}`);
  row.append(label, duration);
  return row;
}

/** Renders a completed immutable report snapshot into the report screen. */
export function renderRunReport(root, report) {
  if (!(root instanceof Element)) throw new TypeError("A report screen element is required.");
  if (!report || !Object.isFrozen(report)) throw new TypeError("An immutable report is required.");

  root.querySelector("[data-report-meta]").textContent =
    `RUN ${report.runNumber} · ${report.lapCount} ${report.lapCount === 1 ? "LAP" : "LAPS"} · ${formatLapTime(report.totalDurationMs)} TOTAL`;
  root.querySelector("[data-report-best]").textContent =
    `BEST ${report.bestLap === null ? "--:--.-" : formatLapTime(report.bestLap.duration)}`;

  const lapRows = root.querySelector("[data-report-laps]");
  lapRows.replaceChildren();
  if (report.laps.length === 0) {
    const empty = document.createElement("p");
    empty.className = "report-empty";
    empty.textContent = "NO COMPLETED LAPS";
    lapRows.append(empty);
  } else {
    lapRows.append(...report.laps.map(createLapRow));
  }

  root.querySelector("[data-report-max-speed]").textContent = displayNumber(report.stats.maxSpeedMph);
  root.querySelector("[data-report-avg-speed]").textContent = displayNumber(report.stats.averageSpeedMph);
  root.querySelector("[data-report-left-lean]").textContent =
    report.stats.maxLeanLeftDegrees === null ? "--" : `${Math.round(report.stats.maxLeanLeftDegrees)}°`;
  root.querySelector("[data-report-right-lean]").textContent =
    report.stats.maxLeanRightDegrees === null ? "--" : `${Math.round(report.stats.maxLeanRightDegrees)}°`;

  const map = root.querySelector("[data-report-map]");
  map.dataset.location = report.location.available ? "available" : "unavailable";
  map.querySelector("[data-map-state]").textContent = report.location.available
    ? "TRACK MAP · READY FOR #10"
    : "NO LOCATION DATA";

  const point = report.topSpeedPoint;
  root.querySelector("[data-top-speed]").textContent = `${displayNumber(point?.speedMph ?? null)} MPH`;
  root.querySelector("[data-top-speed-context]").textContent = formatTopSpeedContext(point);
  // #10 will project the immutable point onto the GPS polyline. Keep the
  // placeholder honest rather than placing a decorative marker at fake coords.
  root.querySelector("[data-top-speed-marker]").hidden = true;

  root.querySelector("[data-save-status]").textContent = "";
}
