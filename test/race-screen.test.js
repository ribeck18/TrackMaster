import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");
const main = await readFile(new URL("../js/main.js", import.meta.url), "utf8");

test("Race reproduces the high-fidelity glanceable instrument layout", () => {
  assert.match(html, /class="screen race-screen" data-screen="race"/);
  assert.match(html, /class="rec-indicator"><span><\/span>REC/);
  assert.match(html, /class="end-button"[^>]*>END RACE/);
  assert.match(html, /class="speed-value race-speed-value"/);
  assert.match(html, /data-race-lean-instrument/);
  assert.match(html, /TAP ANYWHERE FOR NEXT LAP/);
  assert.match(html, /class="race-time"[^>]*>00:00\.0/);
  assert.match(html, /class="race-lap-number">LAP <output data-lap-number>1/);
  assert.match(html, /class="last-lap">LAST <output data-last-lap>--:--\.-/);

  assert.match(css, /\.race-speed-value,[\s\S]*?color: var\(--accent\)/);
  assert.match(css, /\.race-speed-value \{[\s\S]*?176px/);
  assert.match(css, /\.race-lean-instrument \.lean-value \{[\s\S]*?0 0 30px/);
  assert.match(css, /\.race-screen \.instrument-unit \{[\s\S]*?rgba\(255, 255, 255, 0\.5\)/);
  assert.match(css, /\.end-button \{[\s\S]*?right: max\(40px, var\(--safe-inline-end\)\)/);
  assert.match(css, /\.race-tap-prompt \{[\s\S]*?bottom: min\(92px, 20\.7vmin\)/);
  assert.match(css, /\.race-bottom \{[\s\S]*?height: min\(82px, 18\.5vmin\)/);
  assert.match(css, /@keyframes rec-pulse/);
});

test("Ready and Race render speed and lean from the same source snapshots", () => {
  const render = main.slice(main.indexOf("function renderInstruments"), main.indexOf("const instrumentRenderTimer"));
  assert.match(render, /const speedReading = gpsSpeedometer\.snapshot\(\)/);
  assert.match(render, /renderSpeed\(readySpeedValue, readyGpsWarning, speedReading\)/);
  assert.match(render, /renderSpeed\(raceSpeedValue, raceGpsWarning, speedReading\)/);
  assert.match(render, /const leanDegrees = currentLean\(\)/);
  assert.match(render, /readyLeanGauge\.render/);
  assert.match(render, /raceLeanGauge\.render/);
});

test("race actions use native click semantics, reject transition double-taps, and isolate END RACE", () => {
  assert.equal((html.match(/data-action="complete-lap"/g) ?? []).length, 1);
  assert.match(html, /<button class="screen-action" type="button" data-action="complete-lap">/);
  assert.match(main, /MINIMUM_LAP_ACTIVATION_INTERVAL_MS = 500/);
  assert.match(main, /if \(!acceptLapActivation\(now\)\) return/);
  assert.match(main, /moveFocus: shouldMoveFocus\(currentState, nextState\)/);
  assert.match(main, /event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?event\.stopImmediatePropagation\(\)/);
  assert.match(main, /raceTiming = endLapTiming\(raceTiming, now\)/);
  assert.doesNotMatch(
    main.slice(main.indexOf("[data-action=\"end-race\"]"), main.indexOf("[data-action=\"new-run\"]")),
    /completeLap\(/,
  );
});

test("an awaited SAVE result cannot mark a replacement session exported", () => {
  const saveBlock = main.slice(
    main.indexOf("saveButton.addEventListener"),
    main.indexOf("[data-action=\"continue-limited\"]"),
  );
  assert.match(saveBlock, /const sessionBeingSaved = completedSession/);
  assert.match(saveBlock, /runStore\.save\(sessionBeingSaved\.report\)/);
  assert.match(saveBlock, /if \(completedSession !== sessionBeingSaved\) return/);
  assert.match(saveBlock, /\.\.\.sessionBeingSaved, exported: true/);
  assert.doesNotMatch(saveBlock, /\.\.\.completedSession, exported: true/);
});

test("derived session capture and dev raw recording remain separate", () => {
  assert.match(main, /const sessionRecorder = createSessionRecorder/);
  assert.match(main, /const rawRecorder = exportRawRecording \? createRawSensorRecorder/);
  assert.match(main, /captureSessionSample\(sample, \{ acceptedLocation \}\)/);
  assert.match(main, /acceptedTimestamp = gpsSpeedometer\.acceptedLocationTimestamp\(\)/);
  assert.match(main, /acceptedLocation = isAcceptedLocationSample\(sample, acceptedTimestamp\)/);
  assert.match(main, /positionForAcceptedLocation\(sample, acceptedTimestamp, latestPosition\)/);
  assert.match(main, /if \(sample\.type === "location" && !acceptedLocation\) return/);
  assert.match(main, /force: acceptedLocation/);
  assert.match(main, /aggregateRunReport\([\s\S]*?timing: raceTiming, samples: recordedSession\.samples/);
  assert.match(main, /completedSession = Object\.freeze\(\{ report, exported: false \}\)/);
  assert.match(main, /renderRunReport\(reportScreen, report\)/);
  assert.match(html, /MAX SPEED|AVG SPEED|TRACK · TOP SPEED POINT/);
});
