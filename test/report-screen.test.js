import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");
const main = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
const renderer = await readFile(new URL("../js/ui/run-report.js", import.meta.url), "utf8");
const trackMap = await readFile(new URL("../js/core/track-map.js", import.meta.url), "utf8");

test("Report reproduces the dense header, three columns, stat grid, and footer", () => {
  assert.match(html, /class="screen report-screen" data-screen="report"/);
  assert.match(html, /RUN 1 · 0 LAPS · 00:00\.0 TOTAL/);
  assert.match(html, /data-report-best>BEST --:--\.-/);
  assert.match(html, /LAP TIMES/);
  assert.match(html, /MAX SPEED/);
  assert.match(html, /AVG SPEED/);
  assert.match(html, /MAX LEAN · LEFT/);
  assert.match(html, /MAX LEAN · RIGHT/);
  assert.match(html, /TRACK · TOP SPEED POINT/);
  assert.match(html, /data-action="new-run">NEW RUN/);
  assert.match(html, /data-action="save-run">SAVE RUN/);

  assert.match(css, /\.report-screen \{[\s\S]*?max\(20px, var\(--safe-block-start\)\)[\s\S]*?max\(60px, var\(--safe-inline-start\)\)/);
  assert.match(css, /grid-template-columns: 1fr 1\.15fr 1\.1fr/);
  assert.match(css, /\.report-stat-grid \{[\s\S]*?grid-template-columns: repeat\(2/);
  assert.match(css, /\.report-footer \{[\s\S]*?justify-content: flex-end/);
});

test("Report renderer includes all lap rows, tied-best highlighting, and coherent empty states", () => {
  assert.match(renderer, /for \(const lap of report\.laps\)[\s\S]*?createLapRow\(lap, report/);
  assert.match(renderer, /lap\.isBest \? " · BEST"/);
  assert.match(renderer, /NO COMPLETED LAPS/);
  assert.match(trackMap, /NO GPS FIX RECORDED/);
  assert.match(trackMap, /TOO FEW GPS POINTS/);
  assert.match(trackMap, /STATIONARY TRACE/);
  assert.match(renderer, /BEST \$\{report\.bestLap === null \? "--:--\.-"/);
  assert.match(renderer, /report\.lapCount === 1 \? "LAP" : "LAPS"/);
});

test("ended report wiring keeps a reload-reset in-memory run count and reserved identities", () => {
  assert.match(main, /let runCount = 0/);
  assert.match(main, /runCount \+= 1/);
  assert.doesNotMatch(main, /localStorage|sessionStorage|indexedDB/i);
  assert.match(main, /\{ runNumber: runCount, runId: null, riderId: null \}/);
  assert.match(main, /aggregateRunReport\([\s\S]*?renderRunReport\(reportScreen, report, \{ onTrim: applyLapTrim \}\)/);
});

test("NEW RUN confirms only while the completed run is unexported and SAVE uses one seam", () => {
  const newRunBlock = main.slice(
    main.indexOf("[data-action=\"new-run\"]"),
    main.indexOf("[data-action=\"continue-limited\"]"),
  );
  assert.match(newRunBlock, /completedSession &&[\s\S]*?!completedSession\.exported[\s\S]*?!window\.confirm/);
  assert.match(newRunBlock, /const sessionBeingSaved = completedSession/);
  assert.match(newRunBlock, /runStore\.save\(sessionBeingSaved\.report\)/);
  assert.match(newRunBlock, /completedSession !== sessionBeingSaved/);
  assert.match(newRunBlock, /\.\.\.sessionBeingSaved, exported: true/);
  assert.match(main, /const runStore = Object\.freeze\(\{[\s\S]*?async save/);
});

test("SAVE seam receives the latest trimmed report and each ended report clears old accordion state", () => {
  const trimBlock = main.slice(
    main.indexOf("function applyLapTrim"),
    main.indexOf("function render("),
  );
  const endBlock = main.slice(
    main.indexOf("[data-action=\"end-race\"]"),
    main.indexOf("[data-action=\"new-run\"]"),
  );
  const saveBlock = main.slice(
    main.indexOf("saveButton.addEventListener"),
    main.indexOf("[data-action=\"continue-limited\"]"),
  );
  assert.match(trimBlock, /adjustLapBoundaryIfAllowed\([\s\S]*?completedSession\.report/);
  assert.match(trimBlock, /completedSession = Object\.freeze\(\{ report, exported: false \}\)/);
  assert.match(saveBlock, /const sessionBeingSaved = completedSession/);
  assert.match(saveBlock, /runStore\.save\(sessionBeingSaved\.report\)/);
  assert.match(endBlock, /delete reportScreen\.dataset\.expandedLap;[\s\S]*?renderRunReport/);
});

test("recorded session readings carry explicit monotonic GPS freshness", () => {
  assert.match(main, /let lastValidSpeedReceivedAt = null/);
  assert.match(main, /aggregateRunReport,[\s\S]*?MAX_VALID_SPEED_INTERVAL_MS/);
  assert.match(main, /Number\.isFinite\(lastValidSpeedReceivedAt\)[\s\S]*?speedAge <= MAX_VALID_SPEED_INTERVAL_MS/);
  assert.match(main, /speedMph: speed\.hasSpeed \? speed\.mph : null,[\s\S]*?speedValid/);
});

test("track map is a local vector control with styled trace, marker, and legible mode", () => {
  const mapButton = html.match(/<button class="report-map"[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.match(mapButton, /type="button" data-report-map[\s\S]*?<span data-map-state>/);
  assert.doesNotMatch(mapButton, /<p[\s>]/);
  const trackRenderer = renderer.slice(
    renderer.indexOf("function renderTrackMap"),
    renderer.indexOf("/** Renders a completed immutable report"),
  );
  assert.match(trackRenderer, /document\.createElement\("span"\)/);
  assert.doesNotMatch(trackRenderer, /document\.createElement\("p"\)/);
  assert.doesNotMatch(html, /leaflet|mapbox|google\.maps|<canvas/i);
  assert.match(renderer, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", name\)/);
  assert.match(renderer, /COLOR · SPEED · TAP FOR LEAN/);
  assert.match(renderer, /COLOR · LEAN L\/R · TAP FOR SPEED/);
  assert.match(css, /\.report-map__segment \{[\s\S]*?stroke-width: 4\.5/);
  assert.match(css, /\.report-map__marker \{[\s\S]*?fill: var\(--accent\)[\s\S]*?drop-shadow/);
  assert.doesNotMatch(renderer, /fetch\(|XMLHttpRequest|import\(["']https?:/);
});

test("report CSS preserves stat numeral sizing and compact lap rows", () => {
  assert.match(css, /\.report-laps \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column/);
  assert.match(css, /\.report-stat output \{[^}]*font-family: "Rajdhani"/);
  assert.doesNotMatch(css, /\.report-stat output \{[^}]*(?:font:\s*inherit|font-size:|font-weight:|line-height:)/);
});
