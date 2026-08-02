import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");
const main = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

function point(radius, degrees) {
  const angle = (degrees * Math.PI) / 180;
  return {
    x: 200 + radius * Math.sin(angle),
    y: 210 - radius * Math.cos(angle),
  };
}

test("Ready has the handoff instrument columns, resting values, and timer strip", () => {
  assert.match(html, /class="screen ready-screen" data-screen="ready"/);
  assert.match(html, /class="instrument-eyebrow">SPEED</);
  assert.match(html, /class="instrument-eyebrow">LEAN ANGLE</);
  assert.match(html, /data-speed-value[^>]*>--<\/output>/);
  assert.match(html, /class="instrument-unit">MPH</);
  assert.match(html, /class="lean-value"[^>]*>0°<\/output>/);
  assert.match(html, /class="lean-direction">LEVEL<\/span>/);
  assert.match(html, /class="ready-time"[^>]*>00:00\.0<\/output>/);
  assert.match(html, /TAP ANYWHERE TO START RACE/);

  assert.match(css, /\.speed-value \{[\s\S]*?rgba\(255, 255, 255, 0\.82\)/);
  assert.match(css, /\.lean-value \{[\s\S]*?rgba\(255, 255, 255, 0\.82\)/);
  assert.match(css, /\.instrument-divider \{[\s\S]*?background: var\(--hairline\)/);
  assert.match(css, /\.ready-bottom \{[\s\S]*?border-top: 1px solid var\(--hairline\)/);
  assert.match(css, /\.ready-prompt \{[\s\S]*?color: var\(--accent\)/);
});

test("parked SVG uses the exact viewBox, arc, tick, needle, and hub geometry", () => {
  assert.match(html, /<svg viewBox="0 0 400 232"/);
  const left = point(182, -52);
  const right = point(182, 52);
  assert.ok(Math.abs(left.x - 56.582) < 0.001);
  assert.ok(Math.abs(left.y - 97.95) < 0.001);
  assert.ok(Math.abs(right.x - 343.418) < 0.001);
  assert.match(html, /d="M 56\.582 97\.950 A 182 182 0 0 1 343\.418 97\.950"/);

  const ticks = [...html.matchAll(/class="gauge-tick(?: gauge-tick--major)?"/g)];
  const majors = [...html.matchAll(/class="gauge-tick gauge-tick--major"/g)];
  assert.equal(ticks.length, 14, "Ready and Race each render all seven ticks");
  assert.equal(majors.length, 6);
  assert.match(html, /class="gauge-needle" x1="200" y1="210" x2="200" y2="94"/);
  assert.match(html, /class="gauge-hub" cx="200" cy="210" r="14"/);
  assert.match(css, /\.gauge-track,[\s\S]*?stroke-width: 16/);
  assert.match(css, /\.gauge-needle \{[\s\S]*?stroke-width: 6/);
  assert.match(css, /\.gauge-hub \{[\s\S]*?stroke-width: 4/);
});

test("live lean geometry and stable ZERO readiness are wired on Ready", () => {
  assert.match(html, /data-lean-instrument/);
  assert.match(html, /data-calibration-status/);
  assert.match(main, /createBikeFrameCalibrationWindow/);
  assert.match(main, /leanEstimator\.calibrate\(readiness\.gravity\)/);
  assert.match(main, /calibrationWindow\.add\(sample, monotonicNow\(\)\)/);
  assert.match(main, /isGyroDeliveryFresh\(lastGyroReceivedAt, now\)/);
  assert.match(main, /"CONTINUE WITHOUT LEAN"/);
  assert.match(main, /reading\.calibrated && isGyroDeliveryFresh/);
  assert.match(css, /\.gauge-active \{[\s\S]*?transition: d 80ms linear/);
  assert.match(css, /\.gauge-needle \{[\s\S]*?transition: x2 80ms linear, y2 80ms linear/);
});

test("GPS and lean DOM rendering share one capped 200 ms instrument timer", () => {
  assert.match(html, /data-gps-warning role="status">GPS · NO FIX/);
  assert.match(main, /sensorSource\.subscribe\(handleSensorSample\)/);
  assert.match(main, /gpsSpeedometer\.kinematicSample\(\)/);
  assert.match(main, /reading\.hasSpeed \? String\(reading\.mph\) : "--"/);
  assert.match(main, /window\.setInterval\(renderInstruments, 200\)/);
  const handler = main.slice(main.indexOf("function handleSensorSample"), main.indexOf("sensorSource.subscribe"));
  assert.doesNotMatch(handler, /leanGauge\.render/, "native-cadence estimation must not write the DOM");
});

test("Ready remains one native full-screen glove-sized start action", () => {
  assert.match(
    html,
    /<button class="screen-action" type="button" data-action="start-race">/,
  );
  assert.match(css, /\.screen-action \{[\s\S]*?inset: 0;[\s\S]*?width: 100%;[\s\S]*?height: 100%/);
  assert.equal((html.match(/data-action="start-race"/g) ?? []).length, 1);
});

test("compact Ready rules cover 568x320 and 667x375 without hiding labels", () => {
  const compactStart = css.indexOf("@media (orientation: landscape) and (max-height: 375px)");
  const compactEnd = css.indexOf("@media (max-height: 330px)", compactStart);
  assert.ok(compactStart >= 0 && compactEnd > compactStart);
  const compactCss = css.slice(compactStart, compactEnd);

  for (const [width, height] of [[568, 320], [667, 375]]) {
    assert.ok(width > height && height <= 375, `${width}x${height} matches the compact landscape query`);
  }
  assert.match(compactCss, /\.ready-screen,[\s\S]*?\.race-screen \{[\s\S]*?max\(16px, var\(--safe-inline-end\)\)[\s\S]*?max\(28px, var\(--safe-inline-start\)\)/);
  assert.match(compactCss, /\.ready-top \{\s*gap: 8px;/);
  assert.match(compactCss, /\.ready-bottom,[\s\S]*?\.race-bottom \{[\s\S]*?gap: 8px;/);
  assert.match(compactCss, /\.timer-eyebrow,[\s\S]*?\.ready-prompt,[\s\S]*?font-size: 8px;[\s\S]*?letter-spacing: 1px;/);
  assert.doesNotMatch(compactCss, /display:\s*none/);
  for (const label of ["SPEED", "LEAN ANGLE", "MPH", "LAP TIME", "TAP ANYWHERE TO START RACE"]) {
    assert.match(html, new RegExp(label));
  }
});

test("frequent speed updates are outside the app-wide live region", () => {
  assert.match(html, /<main id="app" class="app-shell">/);
  assert.doesNotMatch(html, /<main[^>]*aria-live/);
  assert.match(html, /data-gps-warning role="status"/);
  assert.match(html, /data-recovery-guidance aria-live="polite"/);
  assert.equal((html.match(/aria-live=/g) ?? []).length, 1, "only targeted recovery guidance is live");
});

test("README describes Ready as implemented rather than a routing placeholder", () => {
  assert.match(readme, /Ready renders smoothed live GPS speed in MPH/);
  assert.doesNotMatch(readme, /Ready, Race, and Report retain only the minimum controls/);
});
